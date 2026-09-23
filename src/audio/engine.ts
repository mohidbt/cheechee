import * as Tone from 'tone';
import type { AudioEngine, AudioLifecycleEvent, AudioTrack, Command, CommandResult, DeckId, DJState, TrackAnalysis } from '../../shared/contracts';
import { emptyState } from '../../shared/contracts';
import { analyzeAudioBuffer, contentKeyForBytes, readPersistedAnalysis, writePersistedAnalysis } from './analysis';

type DeckNodes = {
  player: Tone.Player;
  eq: Tone.EQ3;
  filter: Tone.Filter;
  gain: Tone.Gain;
  send: Tone.Gain;
  delay: Tone.FeedbackDelay;
  tail: Tone.Gain;
  analyser: Tone.Analyser;
};
type DeckRuntime = { startedAt: number; startOffset: number; buffer?: Tone.ToneAudioBuffer; loadToken: number; pendingStart?: {time:number; playbackId:string; trackId:string; offset:number} };
const ids: DeckId[] = ['A', 'B'];
const other = (id: DeckId): DeckId => id === 'A' ? 'B' : 'A';
const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));

/** Browser-owned, long-lived mixer. Construct once, outside React render cycles. */
export function createAudioEngine(initialTracks: AudioTrack[]): AudioEngine {
  const state = emptyState();
  const tracks = new Map(initialTracks.map(t => [t.id, t]));
  const cache = new Map<string, Promise<Tone.ToneAudioBuffer>>();
  const preparedBuffers = new Map<string, Tone.ToneAudioBuffer>();
  const prepared = new Set<string>();
  const analysisCache = new Map<string, TrackAnalysis>();
  const analysisPending = new Map<string, Promise<TrackAnalysis>>();
  const runtime: Record<DeckId, DeckRuntime> = { A: {startedAt: 0, startOffset: 0, loadToken: 0}, B: {startedAt: 0, startOffset: 0, loadToken: 0} };
  const listeners = new Set<() => void>();
  const lifecycleListeners = new Set<(event: AudioLifecycleEvent) => void>();
  let nodes: Record<DeckId, DeckNodes> | undefined;
  let crossfade: Tone.CrossFade | undefined;
  let master: Tone.Gain | undefined;
  let limiter: Tone.Limiter | undefined;
  let masterAnalyser: Tone.Analyser | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  let transitionBusy = false;
  let transitionStarted = 0;
  let transitionDuration = 0;
  let transitionStartedEvent = false;
  let transitionSourcePlaybackId = '';
  let transitionTargetPlaybackId = '';
  let audioSuspended = false;
  let disposed = false;
  let ducking = false;
  const emit = () => listeners.forEach(listener => listener());
  const emitLifecycle = (event: AudioLifecycleEvent) => lifecycleListeners.forEach(listener => listener(event));
  const now = () => Tone.immediate();
  const fail = (code: string, message: string): CommandResult => ({ok:false, code, message});
  const ok = (message: string, scheduled = false): CommandResult => ({ok:true, message, ...(scheduled ? {scheduled:true} : {})});
  const ended = (id: DeckId, reason: 'natural'|'stopped'|'transition'|'stop_all', audioTime = now()) => {
    const deck = state.decks[id];
    if (!deck.playbackId || !deck.trackId) return;
    const playbackId = deck.playbackId, trackId = deck.trackId;
    deck.playbackId = null;
    emitLifecycle({type:'ended', deck:id, trackId, playbackId, reason, audioTime});
  };

  function makeDeck(id: DeckId, input: Tone.ToneAudioNode): DeckNodes {
    const player = new Tone.Player({loop:false});
    const eq = new Tone.EQ3();
    const filter = new Tone.Filter(16000, 'lowpass');
    const gain = new Tone.Gain(state.decks[id].volume);
    const send = new Tone.Gain(0);
    const delay = new Tone.FeedbackDelay({delayTime:0.25, feedback:0.35, wet:1});
    const tail = new Tone.Gain(0);
    const analyser = new Tone.Analyser('waveform', 1024);
    player.chain(eq, filter, gain);
    gain.connect(input);
    gain.connect(analyser);
    gain.connect(send);
    send.chain(delay, tail);
    tail.connect(master!);
    return {player, eq, filter, gain, send, delay, tail, analyser};
  }
  function initGraph() {
    if (nodes) return;
    master = new Tone.Gain(state.masterVolume * (ducking ? 0.35 : 1));
    limiter = new Tone.Limiter(-1);
    masterAnalyser = new Tone.Analyser('waveform', 1024);
    crossfade = new Tone.CrossFade(state.crossfader);
    crossfade.connect(master);
    master.connect(masterAnalyser);
    master.chain(limiter, Tone.getDestination());
    nodes = {A:makeDeck('A', crossfade.a), B:makeDeck('B', crossfade.b)};
    for (const id of ids) {
      const s = state.decks[id];
      nodes[id].eq.low.value = s.eq.low;
      nodes[id].eq.mid.value = s.eq.mid;
      nodes[id].eq.high.value = s.eq.high;
      nodes[id].filter.type = s.filter.mode === 'off' ? 'lowpass' : s.filter.mode;
      nodes[id].filter.frequency.value = s.filter.mode === 'off' ? 16000 : s.filter.frequency;
      if (runtime[id].buffer) nodes[id].player.buffer = runtime[id].buffer!;
    }
    ticker = setInterval(tick, 100);
  }
  function tick(notify = true) {
    if (disposed) return;
    if (!state.unlocked) return;
    const time = now();
    state.audioTime = time;
    if (Tone.getContext().state !== 'running') {
      if (!audioSuspended) { audioSuspended = true; emitLifecycle({type:'audio_suspended', audioTime:time}); }
    } else audioSuspended = false;
    for (const id of ids) {
      const s = state.decks[id];
      const pending = runtime[id].pendingStart;
      if (pending && time >= pending.time) {
        runtime[id].pendingStart = undefined;
        runtime[id].startedAt = pending.time;
        runtime[id].startOffset = pending.offset;
        s.playbackId = pending.playbackId;
        s.playedSeconds = Math.max(0, time - pending.time);
        s.status = 'playing';
        emitLifecycle({type:'started', deck:id, trackId:pending.trackId, playbackId:pending.playbackId, audioTime:pending.time});
      }
      if (s.status !== 'playing') continue;
      const elapsed = Math.max(0, time - runtime[id].startedAt);
      s.playedSeconds = Math.max(s.playedSeconds, elapsed);
      s.position = s.loop && s.duration > 0 ? (runtime[id].startOffset + elapsed) % s.duration : Math.min(runtime[id].startOffset + elapsed, s.duration);
      if (!s.loop && elapsed >= s.duration - runtime[id].startOffset && !(state.transition?.from === id && time >= transitionStarted + transitionDuration)) {
        ended(id, 'natural', runtime[id].startedAt + s.duration - runtime[id].startOffset); s.status = 'stopped'; s.position = s.duration;
      }
    }
    if (state.transition) {
      if (!transitionStartedEvent && time >= transitionStarted) {
        transitionStartedEvent = true;
        const t = state.transition;
        emitLifecycle({type:'transition_started', transitionId:t.id, from:t.from, to:t.to,
          fromPlaybackId:transitionSourcePlaybackId, toPlaybackId:transitionTargetPlaybackId, audioTime:transitionStarted});
      }
      if (!state.transition) { if (notify) emit(); return; }
      state.transition.progress = clamp((time - transitionStarted) / transitionDuration);
      const start = state.transition.from === 'A' ? 0 : 1;
      state.crossfader = start + (1 - 2 * start) * state.transition.progress;
      if (time >= transitionStarted + transitionDuration) finishTransition();
    }
    if (notify) emit();
  }
  function loadBuffer(track: AudioTrack): Promise<Tone.ToneAudioBuffer> {
    let pending = cache.get(track.url);
    if (!pending) {
      pending = new Promise((resolve, reject) => {
        const buffer = new Tone.ToneAudioBuffer(track.url, () => resolve(buffer), error => reject(error));
      });
      cache.set(track.url, pending);
      pending.catch(() => { if (cache.get(track.url) === pending) cache.delete(track.url); });
    } else {
      cache.delete(track.url); cache.set(track.url, pending);
    }
    return pending;
  }
  function trimCache() {
    const keep = new Set(ids.map(id => state.decks[id].trackId && tracks.get(state.decks[id].trackId!)?.url).filter(Boolean));
    for (const trackId of prepared) {
      const url = tracks.get(trackId)?.url;
      if (url) keep.add(url);
    }
    for (const [url] of cache) {
      if (cache.size <= 4) break;
      if (!keep.has(url)) { cache.delete(url); preparedBuffers.delete(url); }
    }
  }
  async function prepareTrack(trackId: string): Promise<CommandResult> {
    const track = tracks.get(trackId);
    if (!track) return fail('unknown_track', `Track ${trackId} is unavailable.`);
    const gen = generation;
    try {
      const buffer = await loadBuffer(track);
      if (disposed || gen !== generation || tracks.get(trackId)?.url !== track.url) return fail('cancelled', 'Track preparation was cancelled.');
      preparedBuffers.set(track.url, buffer);
      prepared.add(trackId);
      // One target and one fallback are enough beyond the two deck buffers.
      while (prepared.size > 2) prepared.delete(prepared.values().next().value!);
      trimCache();
      return ok(`Prepared ${track.title}.`);
    } catch (error) {
      return fail('load_failed', `Could not decode ${track.title}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async function analyzeTrack(trackId: string): Promise<TrackAnalysis> {
    const track = tracks.get(trackId);
    if (!track) throw new Error(`Track ${trackId} is unavailable.`);
    const cached = analysisCache.get(track.url);
    if (cached) return cached;
    const gen = generation;
    let pending = analysisPending.get(track.url);
    if (!pending) {
      pending = (async () => {
        const decoded = await loadBuffer(track);
        const pcm = decoded.get();
        if (!pcm) throw new Error(`Track ${track.title} has no decoded audio.`);
        const response = await fetch(track.url);
        if (!response.ok) throw new Error(`Could not read ${track.title} for analysis.`);
        const contentKey = await contentKeyForBytes(await response.arrayBuffer());
        const persisted = await readPersistedAnalysis(contentKey).catch(() => null);
        if (persisted && Math.abs(persisted.durationSeconds.value - pcm.duration) < 0.001) return persisted;
        const analysis = await analyzeAudioBuffer(pcm, contentKey);
        await writePersistedAnalysis(analysis).catch(() => {});
        return analysis;
      })();
      analysisPending.set(track.url, pending);
      void pending.finally(() => { if (analysisPending.get(track.url) === pending) analysisPending.delete(track.url); }).catch(() => {});
    }
    const analysis = await pending;
    if (disposed || gen !== generation || tracks.get(trackId)?.url !== track.url) throw new Error('Track analysis was cancelled.');
    analysisCache.set(track.url, analysis);
    trimCache();
    return analysis;
  }
  function getTrackAnalysis(trackId: string): TrackAnalysis | null {
    const track = tracks.get(trackId);
    return track ? analysisCache.get(track.url) ?? null : null;
  }
  async function load(id: DeckId, trackId: string, internal = false): Promise<CommandResult> {
    const track = tracks.get(trackId);
    if (!track) return fail('unknown_track', `Track ${trackId} is unavailable.`);
    const s = state.decks[id];
    if (!internal && transitionBusy) return fail('busy', 'A transition is in progress.');
    if (s.status === 'playing') return fail('deck_playing', `Stop deck ${id} before loading a track.`);
    const token = ++runtime[id].loadToken;
    const gen = generation;
    const previous = {...s};
    s.status = 'loading'; emit();
    try {
      const buffer = await loadBuffer(track);
      if (disposed || gen !== generation || token !== runtime[id].loadToken) return fail('cancelled', 'Track load was cancelled.');
      runtime[id].buffer = buffer;
      if (nodes) { nodes[id].player.buffer = buffer; nodes[id].player.loop = track.loop; }
      s.trackId = track.id; s.status = 'ready'; s.duration = buffer.duration; s.position = 0; s.loop = track.loop;
      s.playbackId = null; s.playedSeconds = 0;
      trimCache();
      emit();
      return ok(`Loaded ${track.title} on deck ${id}.`);
    } catch (error) {
      if (gen === generation && token === runtime[id].loadToken) Object.assign(s, previous);
      emit();
      return fail('load_failed', `Could not decode ${track.title}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  function play(id: DeckId, incomingOffsetSeconds = 0): CommandResult {
    if (!state.unlocked || !nodes || !crossfade) return fail('audio_locked', 'Enable audio first.');
    if (transitionBusy) return fail('busy', 'A transition is in progress.');
    const s = state.decks[id];
    if (s.status === 'playing') return ok(`Deck ${id} is already playing.`);
    if (!s.trackId || !runtime[id].buffer || s.status === 'loading') return fail('empty_deck', `Load a track on deck ${id} first.`);
    if (!Number.isFinite(incomingOffsetSeconds) || incomingOffsetSeconds < 0 || incomingOffsetSeconds >= s.duration) return fail('invalid_cue', 'Incoming cue is outside the decoded track.');
    if (state.decks[other(id)].status !== 'playing') setCrossfader(id === 'A' ? 0 : 1);
    nodes[id].player.loop = s.loop;
    const time = now();
    nodes[id].player.start(time, incomingOffsetSeconds);
    runtime[id].startedAt = time; runtime[id].startOffset = incomingOffsetSeconds;
    s.status = 'playing'; s.position = incomingOffsetSeconds; s.playedSeconds = 0;
    s.playbackId = crypto.randomUUID();
    emitLifecycle({type:'started', deck:id, trackId:s.trackId, playbackId:s.playbackId, audioTime:time});
    emit();
    return ok(`Playing ${tracks.get(s.trackId)?.title ?? s.trackId} on deck ${id}.`);
  }
  async function commitStart(trackId: string, incomingOffsetSeconds = 0): Promise<CommandResult> {
    if (!state.unlocked || !nodes || !crossfade) return fail('audio_locked', 'Enable audio first.');
    if (transitionBusy || ids.some(id => state.decks[id].status === 'playing' || runtime[id].pendingStart)) return fail('busy', 'A source is already playing.');
    const track = tracks.get(trackId);
    const buffer = track && prepared.has(trackId) ? preparedBuffers.get(track.url) : undefined;
    if (!track || !buffer) return fail('not_prepared', `Track ${trackId} is not prepared.`);
    if (!Number.isFinite(incomingOffsetSeconds) || incomingOffsetSeconds < 0 || incomingOffsetSeconds >= buffer.duration) return fail('invalid_cue', 'Incoming cue is outside the decoded track.');
    const id: DeckId = 'A';
    const s = state.decks[id];
    runtime[id].loadToken++;
    runtime[id].buffer = buffer;
    nodes[id].player.buffer = buffer;
    nodes[id].player.loop = track.loop;
    s.trackId = trackId; s.duration = buffer.duration; s.loop = track.loop;
    s.status = 'ready'; s.position = 0; s.playedSeconds = 0; s.playbackId = null;
    resetInactiveDeck(id);
    const time = now();
    crossfade.fade.cancelAndHoldAtTime(time);
    crossfade.fade.setValueAtTime(0, time);
    state.crossfader = 0;
    return play(id, incomingOffsetSeconds);
  }
  function cancelTransition() {
    transitionBusy = false;
    state.transition = null;
    transitionSourcePlaybackId = '';
    transitionTargetPlaybackId = '';
    if (!nodes) return;
    const time = now();
    crossfade?.fade.cancelAndHoldAtTime(time);
    for (const id of ids) {
      const n = nodes?.[id];
      if (!n) continue;
      n.filter.frequency.cancelAndHoldAtTime(time);
      n.send.gain.cancelAndHoldAtTime(time);
      n.tail.gain.cancelAndHoldAtTime(time);
      n.send.gain.setValueAtTime(0, time);
      n.tail.gain.setValueAtTime(0, time);
      restoreFilter(id);
    }
  }
  function finishTransition() {
    const transition = state.transition;
    if (!transition) return;
    const {from, to, id} = transition;
    const sourcePlaybackId = transitionSourcePlaybackId;
    const targetPlaybackId = transitionTargetPlaybackId;
    state.decks[from].status = 'stopped';
    state.decks[from].position = 0;
    state.crossfader = to === 'A' ? 0 : 1;
    restoreFilter(from);
    transitionBusy = false;
    state.transition = null;
    transitionSourcePlaybackId = '';
    transitionTargetPlaybackId = '';
    ended(from, 'transition', transitionStarted + transitionDuration);
    if (sourcePlaybackId && targetPlaybackId) emitLifecycle({type:'transition_completed', transitionId:id, from, to, fromPlaybackId:sourcePlaybackId, toPlaybackId:targetPlaybackId, audioTime:transitionStarted + transitionDuration});
  }
  function stop(id: DeckId): CommandResult {
    if (transitionBusy) {
      stopAll();
      return ok('Transition cancelled and both decks stopped.');
    }
    runtime[id].loadToken++;
    const n = nodes?.[id];
    const time = n ? now() : 0;
    if (n) {
      n.send.gain.cancelAndHoldAtTime(time);
      n.tail.gain.cancelAndHoldAtTime(time);
      n.send.gain.setValueAtTime(0, time);
      n.tail.gain.setValueAtTime(0, time);
      n.gain.gain.cancelAndHoldAtTime(time);
      n.gain.gain.setValueAtTime(0, time);
      n.player.stop(time);
      n.gain.gain.setValueAtTime(state.decks[id].volume, time + 0.01);
    }
    runtime[id].pendingStart = undefined;
    ended(id, 'stopped', time);
    state.decks[id].status = state.decks[id].trackId ? 'stopped' : 'empty';
    state.decks[id].position = 0; emit();
    return ok(`Stopped deck ${id}.`);
  }
  function setCrossfader(value: number) {
    if (!Number.isFinite(value) || transitionBusy) return;
    state.crossfader = clamp(value);
    if (!transitionBusy) crossfade?.fade.rampTo(state.crossfader, 0.04);
    emit();
  }
  function setMasterVolume(value: number) {
    if (!Number.isFinite(value)) return;
    state.masterVolume = clamp(value);
    master?.gain.rampTo(state.masterVolume * (ducking ? 0.35 : 1), 0.06);
    emit();
  }
  function setDeckVolume(id: DeckId, value: number) {
    if (!Number.isFinite(value)) return;
    state.decks[id].volume = clamp(value);
    nodes?.[id].gain.gain.rampTo(state.decks[id].volume, 0.06);
    emit();
  }
  function setDucking(active: boolean) {
    ducking = active;
    master?.gain.rampTo(state.masterVolume * (active ? 0.35 : 1), active ? 0.12 : 0.3);
  }
  function restoreFilter(id: DeckId) {
    const s = state.decks[id].filter;
    const n = nodes?.[id];
    if (!n) return;
    n.filter.type = s.mode === 'off' ? 'lowpass' : s.mode;
    n.filter.frequency.setValueAtTime(s.mode === 'off' ? 16000 : s.frequency, now());
  }
  function resetInactiveDeck(id: DeckId) {
    const s = state.decks[id];
    s.volume = 0.8;
    s.eq = {low:0, mid:0, high:0};
    s.filter = {mode:'off', frequency:16000};
    const n = nodes?.[id];
    if (!n) return;
    const time = now();
    n.gain.gain.cancelAndHoldAtTime(time);
    n.gain.gain.setValueAtTime(s.volume, time);
    n.eq.low.setValueAtTime(0, time);
    n.eq.mid.setValueAtTime(0, time);
    n.eq.high.setValueAtTime(0, time);
    n.send.gain.cancelAndHoldAtTime(time);
    n.tail.gain.cancelAndHoldAtTime(time);
    n.send.gain.setValueAtTime(0, time);
    n.tail.gain.setValueAtTime(0, time);
    restoreFilter(id);
  }
  function commitTransition(command: Extract<Command, {type:'transition'}>, atAudioTime?: number, incomingOffsetSeconds = 0): CommandResult {
    if (transitionBusy) return fail('busy', 'A transition is already in progress.');
    if (!state.unlocked || !nodes || !crossfade) return fail('audio_locked', 'Enable audio first.');
    const playing = ids.filter(id => state.decks[id].status === 'playing');
    if (playing.length !== 1) return fail('source_required', playing.length ? 'Finish the manual mix before starting a preset.' : 'Load and play a track first.');
    const from = playing[0], to = other(from);
    const target = tracks.get(command.track_id);
    if (!target) return fail('unknown_track', `Track ${command.track_id} is unavailable.`);
    if (!prepared.has(command.track_id)) return fail('not_prepared', `Track ${command.track_id} is not prepared.`);
    if (!cache.has(target.url)) return fail('not_prepared', `Track ${command.track_id} is not cached.`);
    const buffer = preparedBuffers.get(target.url);
    if (!buffer) return fail('not_prepared', `Track ${command.track_id} is not decoded.`);
    if (!Number.isFinite(incomingOffsetSeconds) || incomingOffsetSeconds < 0 || incomingOffsetSeconds >= buffer.duration) return fail('invalid_cue', 'Incoming cue is outside the decoded track.');
    if (!target.loop && buffer.duration - incomingOffsetSeconds < command.duration_seconds) return fail('short_cue', 'Incoming track ends before the transition completes.');
    if (state.decks[to].status === 'playing' || runtime[to].pendingStart) return fail('busy', `Deck ${to} is in use.`);
    const time = atAudioTime ?? now() + 0.03;
    if (!Number.isFinite(time) || time < now() - 0.02 || time > now() + 0.15) return fail('invalid_time', 'Commit time is outside the audio horizon.');
    if (command.duration_seconds < 1 || command.duration_seconds > 12) return fail('invalid_duration', 'Transition duration must be 1 to 12 seconds.');
    if (!['crossfade','filter','echo'].includes(command.style)) return fail('invalid_style', 'Unsupported transition style.');
    const sourceState = state.decks[from];
    if (!sourceState.loop && sourceState.duration - sourceState.position - Math.max(0, time - now()) < command.duration_seconds + 0.02) {
      return fail('source_too_short', 'Source track ends before the transition completes.');
    }
    transitionBusy = true;
    runtime[to].buffer = buffer;
    nodes[to].player.buffer = buffer;
    state.decks[to].trackId = target.id;
    state.decks[to].duration = buffer.duration;
    state.decks[to].loop = target.loop;
    state.decks[to].status = 'ready';
    state.decks[to].position = incomingOffsetSeconds;
    state.decks[to].playedSeconds = 0;
    state.decks[to].playbackId = null;
    resetInactiveDeck(to);
    const duration = command.duration_seconds;
    const source = nodes[from], destination = nodes[to];
    crossfade.fade.cancelAndHoldAtTime(time);
    crossfade.fade.setValueAtTime(from === 'A' ? 0 : 1, time);
    state.crossfader = from === 'A' ? 0 : 1;
    destination.player.loop = target.loop;
    destination.player.start(time, incomingOffsetSeconds);
    runtime[to].pendingStart = {time, playbackId:crypto.randomUUID(), trackId:target.id, offset:incomingOffsetSeconds};
    crossfade.fade.linearRampToValueAtTime(to === 'A' ? 0 : 1, time + duration);
    if (command.style === 'filter') {
      const setupTime = now();
      source.filter.frequency.cancelAndHoldAtTime(setupTime);
      source.filter.frequency.setValueAtTime(40, setupTime);
      source.filter.type = 'highpass';
      source.filter.frequency.setValueAtTime(40, time);
      source.filter.frequency.exponentialRampToValueAtTime(6000, time + duration);
    }
    if (command.style === 'echo') {
      source.send.gain.setValueAtTime(0.55, time);
      source.tail.gain.setValueAtTime(0.5, time);
      source.send.gain.linearRampToValueAtTime(0, time + duration);
      source.tail.gain.setValueAtTime(0.5, time + duration);
      source.tail.gain.linearRampToValueAtTime(0, time + duration + Math.min(2, duration));
    }
    source.player.stop(time + duration);
    const id = crypto.randomUUID();
    state.transition = {id, from, to, style:command.style, progress:0};
    transitionStarted = time; transitionDuration = duration;
    transitionStartedEvent = false;
    transitionSourcePlaybackId = state.decks[from].playbackId!;
    transitionTargetPlaybackId = runtime[to].pendingStart.playbackId;
    emit();
    return ok(`${command.style} transition to ${target.title} scheduled.`, true);
  }
  async function transition(command: Extract<Command, {type:'transition'}>): Promise<CommandResult> {
    if (command.timing === 'next_cue') return fail('cue_scheduler_required', 'A reviewed cue must be scheduled by the controller.');
    if (transitionBusy) return fail('busy', 'A transition is already in progress.');
    if (!state.unlocked || !nodes) return fail('audio_locked', 'Enable audio first.');
    const gen = generation;
    transitionBusy = true;
    const result = await prepareTrack(command.track_id);
    if (gen !== generation || disposed) return fail('cancelled', 'Transition was cancelled.');
    transitionBusy = false;
    return result.ok ? commitTransition(command) : result;
  }
  async function execute(command: Command): Promise<CommandResult> {
    if (disposed) return fail('disposed', 'Audio engine is closed.');
    switch (command.type) {
      case 'get_dj_state': return ok('Current DJ state returned.');
      case 'load_track': return load(command.deck, command.track_id);
      case 'play': return play(command.deck);
      case 'stop': return stop(command.deck);
      case 'set_eq': {
        if (transitionBusy) return fail('busy', 'A transition is in progress.');
        const s = state.decks[command.deck];
        s.eq = {low:command.low_db, mid:command.mid_db, high:command.high_db};
        const n = nodes?.[command.deck];
        n?.eq.low.rampTo(command.low_db, 0.08); n?.eq.mid.rampTo(command.mid_db, 0.08); n?.eq.high.rampTo(command.high_db, 0.08);
        emit(); return ok(`Updated EQ on deck ${command.deck}.`);
      }
      case 'set_filter': {
        if (transitionBusy) return fail('busy', 'A transition is in progress.');
        const s = state.decks[command.deck];
        s.filter = {mode:command.mode, frequency:command.frequency_hz};
        const n = nodes?.[command.deck];
        if (n) {
          n.filter.type = command.mode === 'off' ? 'lowpass' : command.mode;
          n.filter.frequency.rampTo(command.mode === 'off' ? 16000 : command.frequency_hz, command.duration_seconds);
        }
        emit(); return ok(`Updated filter on deck ${command.deck}.`);
      }
      case 'transition': return transition(command);
    }
  }
  function getState(): DJState {
    tick(false);
    return structuredClone(state);
  }
  function getWaveform(id: DeckId): Float32Array {
    const value = nodes?.[id].analyser.getValue();
    return value instanceof Float32Array ? value : new Float32Array(1024);
  }
  function getLevel(id?: DeckId): number {
    const value = id ? getWaveform(id) : masterAnalyser?.getValue();
    if (!(value instanceof Float32Array) || !value.length) return 0;
    let sum = 0;
    for (const sample of value) sum += sample * sample;
    return clamp(Math.sqrt(sum / value.length) * 2);
  }
  function stopAll() {
    generation++;
    prepared.clear();
    for (const id of ids) runtime[id].loadToken++;
    cancelTransition();
    const time = nodes ? now() : 0;
    for (const id of ids) {
      const n = nodes?.[id];
      if (n) {
        n.gain.gain.cancelAndHoldAtTime(time);
        n.gain.gain.setValueAtTime(0, time);
        n.player.stop(time);
        n.send.gain.cancelAndHoldAtTime(time);
        n.tail.gain.cancelAndHoldAtTime(time);
        n.send.gain.setValueAtTime(0, time);
        n.tail.gain.setValueAtTime(0, time);
        n.gain.gain.setValueAtTime(state.decks[id].volume, time + 0.01);
      }
      runtime[id].pendingStart = undefined;
      ended(id, 'stop_all', time);
      const s = state.decks[id];
      s.status = s.trackId ? 'stopped' : 'empty'; s.position = 0;
    }
    emit();
  }
  function dispose() {
    if (disposed) return;
    stopAll(); disposed = true;
    if (ticker) clearInterval(ticker);
    for (const id of ids) {
      const n = nodes?.[id];
      if (n) Object.values(n).forEach(node => node.dispose());
    }
    crossfade?.dispose(); masterAnalyser?.dispose(); master?.dispose(); limiter?.dispose();
    listeners.clear(); lifecycleListeners.clear(); cache.clear(); preparedBuffers.clear(); prepared.clear(); analysisCache.clear(); analysisPending.clear();
  }
  return {
    async unlock() {
      if (disposed) throw new Error('Audio engine is closed.');
      await Tone.start();
      initGraph(); state.unlocked = true; emit();
    },
    execute, getState, prepareTrack, analyzeTrack, getTrackAnalysis, commitStart, commitTransition, getAudioTime:now,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    subscribeLifecycle(listener) { lifecycleListeners.add(listener); return () => lifecycleListeners.delete(listener); },
    setTracks(next) {
      tracks.clear(); next.forEach(track => tracks.set(track.id, track));
      for (const id of prepared) if (!tracks.has(id)) prepared.delete(id);
      const urls = new Set(next.map(track => track.url));
      for (const url of analysisCache.keys()) if (!urls.has(url)) analysisCache.delete(url);
      trimCache(); emit();
    },
    setCrossfader, setMasterVolume, setDeckVolume, setDucking,
    getWaveform, getLevel, stopAll, dispose,
  };
}
