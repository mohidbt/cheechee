import * as Tone from 'tone';
import type { AudioEngine, AudioTrack, Command, CommandResult, DeckId, DJState } from '../../shared/contracts';
import { emptyState } from '../../shared/contracts';

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
type DeckRuntime = { startedAt: number; buffer?: Tone.ToneAudioBuffer; loadToken: number };
const ids: DeckId[] = ['A', 'B'];
const other = (id: DeckId): DeckId => id === 'A' ? 'B' : 'A';
const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));

/** Browser-owned, long-lived mixer. Construct once, outside React render cycles. */
export function createAudioEngine(initialTracks: AudioTrack[]): AudioEngine {
  const state = emptyState();
  const tracks = new Map(initialTracks.map(t => [t.id, t]));
  const cache = new Map<string, Promise<Tone.ToneAudioBuffer>>();
  const runtime: Record<DeckId, DeckRuntime> = { A: {startedAt: 0, loadToken: 0}, B: {startedAt: 0, loadToken: 0} };
  const listeners = new Set<() => void>();
  let nodes: Record<DeckId, DeckNodes> | undefined;
  let crossfade: Tone.CrossFade | undefined;
  let master: Tone.Gain | undefined;
  let limiter: Tone.Limiter | undefined;
  let masterAnalyser: Tone.Analyser | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let transitionBusy = false;
  let transitionStarted = 0;
  let transitionDuration = 0;
  let disposed = false;
  let ducking = false;
  const emit = () => listeners.forEach(listener => listener());
  const now = () => Tone.now();
  const fail = (code: string, message: string): CommandResult => ({ok:false, code, message});
  const ok = (message: string, scheduled = false): CommandResult => ({ok:true, message, ...(scheduled ? {scheduled:true} : {})});

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
    for (const id of ids) {
      const s = state.decks[id];
      if (s.status !== 'playing') continue;
      const elapsed = Math.max(0, time - runtime[id].startedAt);
      s.position = s.loop && s.duration > 0 ? elapsed % s.duration : Math.min(elapsed, s.duration);
      if (!s.loop && elapsed >= s.duration) { s.status = 'stopped'; s.position = 0; }
    }
    if (state.transition) {
      state.transition.progress = clamp((time - transitionStarted) / transitionDuration);
      const start = state.transition.from === 'A' ? 0 : 1;
      state.crossfader = start + (1 - 2 * start) * state.transition.progress;
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
    }
    return pending;
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
      emit();
      return ok(`Loaded ${track.title} on deck ${id}.`);
    } catch (error) {
      if (gen === generation && token === runtime[id].loadToken) Object.assign(s, previous);
      emit();
      return fail('load_failed', `Could not decode ${track.title}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  function play(id: DeckId): CommandResult {
    if (!state.unlocked || !nodes || !crossfade) return fail('audio_locked', 'Enable audio first.');
    if (transitionBusy) return fail('busy', 'A transition is in progress.');
    const s = state.decks[id];
    if (s.status === 'playing') return ok(`Deck ${id} is already playing.`);
    if (!s.trackId || !runtime[id].buffer || s.status === 'loading') return fail('empty_deck', `Load a track on deck ${id} first.`);
    if (state.decks[other(id)].status !== 'playing') setCrossfader(id === 'A' ? 0 : 1);
    nodes[id].player.loop = s.loop;
    nodes[id].player.start();
    runtime[id].startedAt = now(); s.status = 'playing'; s.position = 0; emit();
    return ok(`Playing ${tracks.get(s.trackId)?.title ?? s.trackId} on deck ${id}.`);
  }
  function cancelTransition() {
    if (finishTimer) clearTimeout(finishTimer);
    finishTimer = undefined;
    transitionBusy = false;
    state.transition = null;
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
      n.gain.gain.linearRampToValueAtTime(0, time + 0.035);
      n.player.stop(time + 0.04);
      n.gain.gain.setValueAtTime(state.decks[id].volume, time + 0.045);
    }
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
  async function transition(command: Extract<Command, {type:'transition'}>): Promise<CommandResult> {
    if (transitionBusy) return fail('busy', 'A transition is already in progress.');
    if (!state.unlocked || !nodes || !crossfade) return fail('audio_locked', 'Enable audio first.');
    const playing = ids.filter(id => state.decks[id].status === 'playing');
    if (playing.length !== 1) return fail('source_required', playing.length ? 'Finish the manual mix before starting a preset.' : 'Load and play a track first.');
    const from = playing[0], to = other(from);
    const target = tracks.get(command.track_id);
    if (!target) return fail('unknown_track', `Track ${command.track_id} is unavailable.`);
    transitionBusy = true;
    const gen = generation;
    // Keep source audible while target decodes.
    const loaded = await load(to, command.track_id, true);
    if (!loaded.ok) { if (gen === generation) transitionBusy = false; return loaded; }
    if (gen !== generation || disposed || !nodes || !crossfade) return fail('cancelled', 'Transition was cancelled.');
    resetInactiveDeck(to);
    const duration = command.duration_seconds;
    const time = now() + 0.03;
    const source = nodes[from], destination = nodes[to];
    crossfade.fade.cancelAndHoldAtTime(time);
    crossfade.fade.setValueAtTime(from === 'A' ? 0 : 1, time);
    state.crossfader = from === 'A' ? 0 : 1;
    destination.player.loop = target.loop;
    destination.player.start(time);
    runtime[to].startedAt = time;
    state.decks[to].status = 'playing'; state.decks[to].position = 0;
    crossfade.fade.linearRampToValueAtTime(to === 'A' ? 0 : 1, time + duration);
    if (command.style === 'filter') {
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
    source.player.stop(time + duration + 0.02);
    const id = crypto.randomUUID();
    state.transition = {id, from, to, style:command.style, progress:0};
    transitionStarted = time; transitionDuration = duration;
    finishTimer = setTimeout(() => {
      if (gen !== generation || !state.transition || state.transition.id !== id) return;
      state.decks[from].status = 'stopped'; state.decks[from].position = 0;
      state.crossfader = to === 'A' ? 0 : 1;
      if (command.style === 'filter') restoreFilter(from);
      transitionBusy = false; state.transition = null; emit();
    }, (duration + 0.07) * 1000);
    emit();
    return ok(`${command.style} transition to ${target.title} scheduled.`, true);
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
    for (const id of ids) runtime[id].loadToken++;
    cancelTransition();
    const time = nodes ? now() : 0;
    for (const id of ids) {
      const n = nodes?.[id];
      if (n) {
        n.gain.gain.cancelAndHoldAtTime(time);
        n.gain.gain.linearRampToValueAtTime(0, time + 0.03);
        n.player.stop(time + 0.04);
        n.gain.gain.setValueAtTime(state.decks[id].volume, time + 0.05);
      }
      const s = state.decks[id];
      s.status = s.trackId ? 'stopped' : 'empty'; s.position = 0;
    }
    emit();
  }
  function dispose() {
    if (disposed) return;
    stopAll(); disposed = true;
    if (ticker) clearInterval(ticker);
    if (finishTimer) clearTimeout(finishTimer);
    for (const id of ids) {
      const n = nodes?.[id];
      if (n) Object.values(n).forEach(node => node.dispose());
    }
    crossfade?.dispose(); masterAnalyser?.dispose(); master?.dispose(); limiter?.dispose();
    listeners.clear(); cache.clear();
  }
  return {
    async unlock() {
      if (disposed) throw new Error('Audio engine is closed.');
      await Tone.start();
      initGraph(); state.unlocked = true; emit();
    },
    execute, getState,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setTracks(next) { tracks.clear(); next.forEach(track => tracks.set(track.id, track)); emit(); },
    setCrossfader, setMasterVolume, setDeckVolume, setDucking,
    getWaveform, getLevel, stopAll, dispose,
  };
}
