import type { AudioEngine, AudioLifecycleEvent, AudioTrack, ClientMessage, Command, CommandResult, Decision, DecisionAck, MusicalContext, PlayedTrack, ServerMessage } from '../../shared/contracts';
import { buildMusicalContext, DEFAULT_CHANGE_INTERVAL_SECONDS, DEFAULT_OBJECTIVE } from './context';
import { cueSetFor, incomingCueOffset, selectExitCue, upcomingCueExits } from './cues';
import type { CueOccurrence } from './cues';

type Request = Extract<ClientMessage, { type: 'autonomy_request' }>;
type Reply = Extract<ServerMessage, { type: 'dj_decision' }>;
export type AutopilotStatus = { mode: 'off' | 'running' | 'paused'; phase: 'idle' | 'deciding' | 'preparing' | 'ready' | 'transitioning'; objective: string; changeIntervalSeconds: number; line: string; nextTrackId: string | null; secondsUntilNext: number | null };
export type AutopilotTrace = { key: string; text: string; detail?: string; status?: 'requested' | 'accepted' | 'preparing' | 'ready' | 'scheduled' | 'started' | 'completed' | 'failed' | 'cancelled' | 'fallback' };
export type AutopilotTransport = {
  requestAutonomy(request: Request, onDecision: (reply: Reply) => Promise<DecisionAck>, onFailure: (reason: string) => void): boolean;
  cancelAutonomy(): void;
};
export type AutopilotClock = { now: () => number; setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>; clearInterval: (id: ReturnType<typeof setInterval>) => void; setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>; clearTimeout: (id: ReturnType<typeof setTimeout>) => void };
const browserClock: AutopilotClock = { now: () => performance.now(), setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: id => clearInterval(id), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };
const MODEL_TIMEOUT = 10_000;
const PREPARATION_MARGIN_SECONDS = 5;
const MIN_SAFE_PLANNING_LEAD_SECONDS = MODEL_TIMEOUT / 1000 + PREPARATION_MARGIN_SECONDS;
const COMMIT_LEAD = 0.15;

type Plan = { trackId: string; style: 'crossfade' | 'filter' | 'echo'; duration: number; explanation?: string; fallback: boolean; prepared: boolean; preparing: boolean; requestId?: string };
type Window = { sourcePlaybackId: string | null; baseDesired: number; desired: number; cue: CueOccurrence | null; deadline: number; planning: number; fade: number; requested: boolean; deferred: boolean; committed: boolean; fallback: Plan | null; chosen: Plan | null; recovery: boolean; id: string; unavailableSince?: number };
type ManualCue = { command: Extract<Command, { type: 'transition' }>; sourcePlaybackId: string; targetAudioTime: number; incomingOffset: number; timer: ReturnType<typeof setInterval> };

export class AutopilotController {
  private mode: AutopilotStatus['mode'] = 'off';
  private phase: AutopilotStatus['phase'] = 'idle';
  private objective = DEFAULT_OBJECTIVE;
  private changeIntervalSeconds = DEFAULT_CHANGE_INTERVAL_SECONDS;
  private line = 'Autopilot is off.';
  private sessionId = '';
  private revision = 0;
  private history: PlayedTrack[] = [];
  private unavailable = new Set<string>();
  private window: Window | null = null;
  private interval?: ReturnType<typeof setInterval>;
  private timeout?: ReturnType<typeof setTimeout>;
  private unsubscribe: () => void;
  private epoch = 0;
  private requestId: string | null = null;
  private requestStarted = 0;
  private manualCue: ManualCue | null = null;
  private manualEpoch = 0;

  constructor(private engine: AudioEngine, private bridge: AutopilotTransport, private tracks: () => AudioTrack[], private onStatus: (status: AutopilotStatus) => void, private onTrace: (trace: AutopilotTrace) => void, private clock: AutopilotClock = browserClock) {
    this.unsubscribe = engine.subscribeLifecycle(event => this.lifecycle(event));
    this.publish();
  }

  getStatus(): AutopilotStatus {
    const next = this.window?.chosen || this.window?.fallback;
    return { mode: this.mode, phase: this.phase, objective: this.objective, changeIntervalSeconds: this.changeIntervalSeconds, line: this.line, nextTrackId: next?.trackId || null, secondsUntilNext: this.window?.sourcePlaybackId ? Math.max(0, this.window.desired - this.engine.getAudioTime()) : null };
  }
  private refreshHistory() { for (const deck of Object.values(this.engine.getState().decks)) { const entry = this.history.find(item => item.playbackId === deck.playbackId); if (entry) entry.playedSeconds = Math.max(entry.playedSeconds, deck.playedSeconds); } }
  getHistory(): PlayedTrack[] { this.refreshHistory(); return [...this.history]; }
  getContext(): MusicalContext {
    this.refreshHistory();
    const plan = this.window?.chosen || this.window?.fallback;
    const pending = this.manualCue ? { trackId: this.manualCue.command.track_id, prepared: true, committed: false, cancellable: true, secondsUntilStart: Math.max(0, this.manualCue.targetAudioTime - this.engine.getAudioTime()) } : plan ? { trackId: plan.trackId, prepared: plan.prepared, committed: !!this.window?.committed, cancellable: !this.window?.committed, secondsUntilStart: this.window?.sourcePlaybackId ? Math.max(0, this.window.desired - this.engine.getAudioTime()) : undefined } : null;
    return buildMusicalContext(this.engine.getState(), this.tracks(), this.objective, this.history, pending, this.window?.sourcePlaybackId ? Math.max(0, this.window.desired - this.engine.getAudioTime()) : undefined, id => this.engine.getTrackAnalysis?.(id) || null, this.changeIntervalSeconds);
  }
  private publish() { this.onStatus(this.getStatus()); }
  private trace(key: string, text: string, detail?: string, status?: AutopilotTrace['status']) { this.onTrace({ key, text, detail, status }); }
  private source() { const state = this.engine.getState(); return state.transition && state.decks[state.transition.from].status === 'playing' ? state.decks[state.transition.from] : (['A', 'B'] as const).map(id => state.decks[id]).find(deck => deck.status === 'playing' && deck.playbackId) || null; }
  private eligible() { return this.tracks().filter(track => !this.unavailable.has(track.id)); }
  private ranked(sourceTrackId?: string | null) {
    const all = this.eligible();
    const choices = all.length > 1 ? all.filter(track => track.id !== sourceTrackId) : all;
    const usableBpm = (id: string) => { const reviewed = cueSetFor(id)?.reviewedPulseGrid?.bpm; if (reviewed) return reviewed; const track = this.tracks().find(t => t.id === id); const analysis = this.engine.getTrackAnalysis?.(id); const bpm = analysis?.estimatedTempo?.bpm; const duration = analysis?.durationSeconds.value; return bpm && duration && (!track?.loop || Math.abs(duration * bpm / 60 - Math.round(duration * bpm / 60)) <= 0.12) ? bpm : null; };
    const sourceBpm = sourceTrackId ? usableBpm(sourceTrackId) : null;
    return choices.sort((a, b) => {
      const comparable = (id: string) => {
        const bpm = usableBpm(id);
        return sourceBpm && bpm ? Math.abs(bpm - sourceBpm) / sourceBpm <= 0.08 ? 0 : 1 : 1;
      };
      const tempoDifference = comparable(a.id) - comparable(b.id);
      if (tempoDifference) return tempoDifference;
      const recent = (id: string) => this.history.map(h => h.trackId).lastIndexOf(id);
      return recent(a.id) - recent(b.id) || this.tracks().findIndex(t => t.id === a.id) - this.tracks().findIndex(t => t.id === b.id);
    });
  }
  private windowIsCurrent(window: Window, epoch: number) { return this.mode === 'running' && this.window === window && this.epoch === epoch && (!window.sourcePlaybackId || this.source()?.playbackId === window.sourcePlaybackId); }
  private clearRequest(cancel = true) { if (this.timeout) this.clock.clearTimeout(this.timeout); this.timeout = undefined; if (cancel && this.requestId) this.bridge.cancelAutonomy(); this.requestId = null; }
  private invalidate() { this.epoch++; this.revision++; this.clearRequest(); if (this.window && !this.window.committed) this.trace(this.window.id, 'Pending Autopilot move cancelled.', undefined, 'cancelled'); this.window = null; }

  setObjective(value: string) {
    const next = value.trim().slice(0, 500) || DEFAULT_OBJECTIVE;
    if (next === this.objective) return;
    this.objective = next;
    if (this.mode === 'running') { this.invalidate(); this.adopt(); }
    this.publish();
  }
  setChangeInterval(seconds: number) {
    if (!Number.isFinite(seconds)) return;
    const next = Math.max(20, Math.min(120, Math.round(seconds)));
    if (next === this.changeIntervalSeconds) return;
    this.changeIntervalSeconds = next;
    if (this.mode === 'running') { this.invalidate(); this.adopt(); }
    this.publish();
  }
  enable(): boolean {
    if (this.mode === 'running') return true;
    const state = this.engine.getState();
    if (!state.unlocked) { this.line = 'Enable audio first.'; this.publish(); return false; }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { this.line = 'Open the page to start Autopilot.'; this.publish(); return false; }
    const playing = (['A', 'B'] as const).filter(id => state.decks[id].status === 'playing');
    if (playing.length > 1 && !state.transition) { this.line = 'Stop one manual deck before enabling Autopilot.'; this.publish(); return false; }
    this.cancelManualCue(); this.invalidate(); this.mode = 'running'; this.sessionId = crypto.randomUUID(); this.unavailable.clear();
    this.line = 'Preparing the set.';
    this.interval = this.clock.setInterval(() => this.tick(), 100);
    this.adopt(); this.publish(); return true;
  }
  disable(reason = 'Autopilot is off.') { this.invalidate(); this.mode = 'off'; this.phase = 'idle'; this.line = reason; if (this.interval) this.clock.clearInterval(this.interval); this.interval = undefined; this.publish(); }
  pause(reason = 'Paused for manual control.') { if (this.mode !== 'running') return; this.invalidate(); this.mode = 'paused'; this.phase = 'idle'; this.line = reason; if (this.interval) this.clock.clearInterval(this.interval); this.interval = undefined; this.publish(); }
  stopAll() { this.cancelManualCue(); this.disable('Autopilot stopped.'); }
  catalogueChanged() { this.cancelManualCue(); if (this.mode !== 'running') return; this.invalidate(); this.adopt(); }
  dispose() { this.cancelManualCue(); this.disable(); this.unsubscribe(); }

  cancelManualCue() {
    this.manualEpoch++;
    if (this.manualCue) { this.clock.clearInterval(this.manualCue.timer); this.trace('manual-cue', 'Scheduled manual cue cancelled.', undefined, 'cancelled'); }
    this.manualCue = null;
  }
  async scheduleManualCue(command: Extract<Command, { type: 'transition' }>): Promise<CommandResult> {
    this.cancelManualCue();
    const source = this.source();
    if (!source?.playbackId || this.engine.getState().transition || Object.values(this.engine.getState().decks).filter(deck => deck.status === 'playing').length !== 1) return { ok: false, code: 'no_source', message: 'A single playing source is required for next cue.' };
    const cue = upcomingCueExits(source, this.engine.getTrackAnalysis?.(source.trackId || '') || null, 30)
      .find(item => item.reviewed && item.secondsUntil >= 0.5 && item.fileSeconds + command.duration_seconds <= source.duration - 0.15);
    if (!cue) return { ok: false, code: 'no_valid_cue', message: 'No reviewed cue fits this transition in the next 30 seconds. Use an immediate transition.' };
    const track = this.tracks().find(item => item.id === command.track_id);
    if (!track) return { ok: false, code: 'unknown_track', message: 'The requested track is unavailable.' };
    const epoch = this.manualEpoch;
    const playbackId = source.playbackId;
    const targetAudioTime = this.engine.getAudioTime() + cue.secondsUntil;
    const prepared = await this.engine.prepareTrack(track.id);
    if (epoch !== this.manualEpoch || this.source()?.playbackId !== playbackId) return { ok: false, code: 'cancelled', message: 'Cue cancelled because playback changed.' };
    if (!prepared.ok) return prepared;
    if (this.engine.getAudioTime() >= targetAudioTime - COMMIT_LEAD) return { ok: false, code: 'cue_passed', message: 'Preparation missed the selected cue. Ask for the next cue again or use an immediate transition.' };
    const targetAnalysis = this.engine.getTrackAnalysis?.(track.id) || null;
    const offset = incomingCueOffset(track.id, targetAnalysis?.durationSeconds.value ?? Infinity, targetAnalysis, track.loop);
    const timer = this.clock.setInterval(() => {
      if (!this.manualCue || this.manualCue.timer !== timer) return;
      const now = this.engine.getAudioTime();
      if (this.source()?.playbackId !== playbackId || this.engine.getState().transition || now > targetAudioTime + 0.05) { this.cancelManualCue(); return; }
      if (now < targetAudioTime - COMMIT_LEAD) return;
      this.clock.clearInterval(timer); this.manualCue = null;
      const result = this.engine.commitTransition(command, Math.max(now + 0.01, targetAudioTime), offset);
      this.trace('manual-cue', result.ok ? `Manual next cue committed: ${track.title}.` : `Manual next cue failed: ${result.message}`, JSON.stringify({ cue, targetAudioTime, result }), result.ok ? 'scheduled' : 'failed');
    }, 50);
    this.manualCue = { command, sourcePlaybackId: playbackId, targetAudioTime, incomingOffset: offset, timer };
    this.trace('manual-cue', `Manual transition scheduled for next reviewed cue in ${cue.secondsUntil.toFixed(1)}s.`, JSON.stringify({ cue, trackId: track.id, durationSeconds: command.duration_seconds }), 'scheduled');
    return { ok: true, scheduled: true, message: `Transition to ${track.title} scheduled for a reviewed cue in ${cue.secondsUntil.toFixed(1)} seconds. Playback has not changed yet.` };
  }

  private adopt() {
    if (this.mode !== 'running') return;
    if (this.engine.getState().transition) return;
    const source = this.source();
    if (!source) { this.coldStart(); return; }
    if (this.window?.sourcePlaybackId === source.playbackId) return;
    this.clearRequest();
    const now = this.engine.getAudioTime();
    const pacedRemaining = Math.max(0, this.changeIntervalSeconds - source.playedSeconds);
    const safeRemaining = Math.max(pacedRemaining, MIN_SAFE_PLANNING_LEAD_SECONDS);
    const naturalRemaining = Math.max(0, source.duration - source.position);
    const fade = source.loop ? 4 : Math.min(4, Math.max(0, naturalRemaining - 2.15));
    const hard = source.loop ? safeRemaining : Math.min(safeRemaining, Math.max(0.15, naturalRemaining - fade - 2));
    const remaining = Math.max(0.15, hard);
    const baseDesired = now + remaining;
    const candidateCue = fade >= 1 ? selectExitCue(source, this.engine.getTrackAnalysis?.(source.trackId || '') || null, source.playedSeconds + remaining, fade, Math.min(MIN_SAFE_PLANNING_LEAD_SECONDS, remaining)) : null;
    const cue = candidateCue && (source.loop || candidateCue.secondsUntil <= naturalRemaining - fade - 2) ? candidateCue : null;
    const desired = cue ? now + cue.secondsUntil : baseDesired;
    const tooShortForDecision = fade < 1 || desired - now < MIN_SAFE_PLANNING_LEAD_SECONDS - 0.001;
    const window: Window = { id: `${this.sessionId}:${source.playbackId}`, sourcePlaybackId: source.playbackId, baseDesired, desired, cue, deadline: Math.max(now, desired - PREPARATION_MARGIN_SECONDS), planning: Math.max(now, desired - 25), fade, requested: tooShortForDecision, deferred: false, committed: false, fallback: null, chosen: null, recovery: false };
    this.window = window;
    this.phase = 'idle';
    this.line = fade < 1 ? 'Track is too short for a safe fade. Preparing recovery at its natural end.' : `Playing ${this.tracks().find(t => t.id === source.trackId)?.title || source.trackId}. Planning the next move.`;
    this.trace(window.id, `Playback ${source.trackId} adopted. Next move in ${Math.round(desired - now)}s.`, JSON.stringify({ playbackId: source.playbackId, desiredAudioTime: desired, planningAudioTime: window.planning, cue: cue ? { kind: cue.kind, fileSeconds: cue.fileSeconds, provenance: cue.provenance, reviewed: cue.reviewed, alignment: cue.alignment } : null }), 'requested');
    if (tooShortForDecision) this.trace(window.id, 'Using local fallback for a short track.', `Available lead ${remaining.toFixed(1)}s.`, 'fallback');
    void this.prepareFallback(window);
    this.tick();
  }
  private coldStart() {
    const window: Window = { id: `${this.sessionId}:start`, sourcePlaybackId: null, baseDesired: 0, desired: 0, cue: null, deadline: Infinity, planning: 0, fade: 4, requested: false, deferred: false, committed: false, fallback: null, chosen: null, recovery: false };
    this.window = window; this.phase = 'preparing'; this.line = 'Preparing the first track.'; this.publish();
    void this.prepareFallback(window);
    this.request(window, 'cold_start');
  }
  private async prepareFallback(window: Window) {
    const epoch = this.epoch;
    for (const track of this.ranked(this.source()?.trackId)) {
      if (!this.windowIsCurrent(window, epoch)) return;
      const started = this.clock.now();
      const result = await this.engine.prepareTrack(track.id);
      if (!this.windowIsCurrent(window, epoch)) return;
      if (result.ok) {
        window.fallback = { trackId: track.id, style: 'crossfade', duration: window.fade, fallback: true, prepared: true, preparing: false };
        this.trace(window.id, `Local fallback ready: ${track.title}.`, `Rule: least recently played eligible track; decode ${Math.round(this.clock.now() - started)} ms.`, 'ready');
        if (!window.sourcePlaybackId && !window.chosen && !this.requestId && window.unavailableSince === undefined) void this.commitColdStart(window, 'Agent unavailable or timed out.');
        this.publish(); return;
      }
      this.unavailable.add(track.id);
      this.trace(window.id, `Could not prepare ${track.title}.`, result.message, 'failed');
    }
    this.pause('No decodable tracks are available.');
  }
  private request(window: Window, trigger: Request['trigger']) {
    if (!this.windowIsCurrent(window, this.epoch) || window.requested || this.requestId) return;
    if (window.sourcePlaybackId && this.engine.getAudioTime() >= window.deadline) { window.requested = true; return; }
    window.requested = true;
    const requestId = crypto.randomUUID(); this.requestId = requestId; this.requestStarted = this.clock.now();
    const now = this.engine.getAudioTime();
    const request: Request = { type: 'autonomy_request', requestId, sessionId: this.sessionId, controlRevision: this.revision, sourcePlaybackId: window.sourcePlaybackId, trigger, desiredInSeconds: window.sourcePlaybackId ? Math.max(0, window.desired - now) : null, hardDeadlineInSeconds: window.sourcePlaybackId ? Math.max(0, window.deadline - now) : null, context: this.getContext() };
    const epoch = this.epoch;
    const sent = this.bridge.requestAutonomy(request, reply => this.accept(window, epoch, requestId, reply), reason => this.failRequest(window, epoch, requestId, reason));
    if (!sent) {
      this.requestId = null; window.requested = false;
      if (window.unavailableSince === undefined) { window.unavailableSince = this.clock.now(); this.trace(window.id, 'Waiting for the agent connection or current request. Local fallback is ready.', undefined, 'scheduled'); }
      this.phase = window.fallback?.prepared ? 'ready' : 'preparing'; this.publish(); return;
    }
    window.unavailableSince = undefined;
    this.phase = 'deciding'; this.line = trigger === 'cold_start' ? 'Choosing the first track.' : 'Choosing the next track.';
    this.trace(requestId, `Autopilot ${trigger.replace('_', ' ')}: deciding.`, JSON.stringify(request), 'requested'); this.publish();
    this.timeout = this.clock.setTimeout(() => this.failRequest(window, epoch, requestId, 'Agent decision timed out.'), MODEL_TIMEOUT);
  }
  private failRequest(window: Window, epoch: number, requestId: string, reason: string) {
    if (!this.windowIsCurrent(window, epoch) || this.requestId !== requestId) return;
    this.clearRequest(); this.trace(requestId, `Local fallback: ${reason}`, `Model latency ${Math.round(this.clock.now() - this.requestStarted)} ms.`, 'fallback');
    if (!window.sourcePlaybackId && window.fallback) void this.commitColdStart(window, reason);
    else { this.phase = window.fallback?.prepared ? 'ready' : 'preparing'; this.publish(); }
  }
  private async accept(window: Window, epoch: number, requestId: string, reply: Reply): Promise<DecisionAck> {
    const reject = (message: string, code: string): DecisionAck => { if (this.requestId === requestId) this.clearRequest(false); this.trace(requestId, `Decision rejected: ${message}`, JSON.stringify(reply.decision), 'failed'); if (!window.sourcePlaybackId && window.fallback) void this.commitColdStart(window, message); return { accepted: false, message, code }; };
    if (!this.windowIsCurrent(window, epoch) || this.requestId !== requestId || reply.sessionId !== this.sessionId || reply.controlRevision !== this.revision || reply.sourcePlaybackId !== window.sourcePlaybackId) return reject('Stale playback or revision.', 'stale');
    if (window.sourcePlaybackId && this.engine.getAudioTime() > window.deadline) return reject('Preparation deadline passed.', 'expired');
    const decision: Decision = reply.decision;
    if (decision.type === 'wait') {
      if (window.deferred || !window.sourcePlaybackId) return reject('Wait is unavailable for this window.', 'invalid_wait');
      const source = this.source();
      const maximum = source?.loop ? Infinity : this.engine.getAudioTime() + Math.max(0, (source?.duration || 0) - (source?.position || 0) - 6);
      const baseDesired = window.baseDesired + decision.defer_seconds;
      const cue = source ? selectExitCue(source, this.engine.getTrackAnalysis?.(source.trackId || '') || null, source.playedSeconds + Math.max(0, baseDesired - this.engine.getAudioTime()), window.fade, 10) : null;
      const desired = cue ? this.engine.getAudioTime() + cue.secondsUntil : baseDesired;
      if (desired > maximum || desired - 5 - this.engine.getAudioTime() < 10) return reject('Wait would exceed the safe deadline.', 'unsafe_wait');
      window.deferred = true; window.baseDesired = baseDesired; window.desired = desired; window.cue = cue; window.deadline = desired - 5; window.planning = Math.max(this.engine.getAudioTime(), desired - 25); window.requested = false;
      this.clearRequest(false); this.trace(requestId, `Agent explanation: ${decision.explanation}`, JSON.stringify({ decision, modelLatencyMs: Math.round(this.clock.now() - this.requestStarted) }), 'accepted'); this.phase = 'idle'; this.publish(); return { accepted: true, message: 'Wait accepted; a new decision will be requested at the revised planning time.' };
    }
    if (decision.type === 'start' && window.sourcePlaybackId || decision.type === 'transition' && !window.sourcePlaybackId) return reject('Decision does not match playback phase.', 'wrong_phase');
    const track = this.eligible().find(item => item.id === decision.track_id);
    if (!track) return reject('Track is unavailable.', 'unknown_track');
    if (window.sourcePlaybackId && this.source()?.trackId === track.id && this.eligible().length > 1) return reject('Choose another track.', 'same_track');
    if (decision.type === 'transition') {
      const source = this.source();
      const revisedCue = source ? selectExitCue(source, this.engine.getTrackAnalysis?.(source.trackId || '') || null, source.playedSeconds + Math.max(0, window.baseDesired - this.engine.getAudioTime()), decision.duration_seconds, 5) : null;
      const revisedDesired = revisedCue ? this.engine.getAudioTime() + revisedCue.secondsUntil : window.baseDesired;
      if (this.engine.getAudioTime() > revisedDesired - 5) return reject('Cue or preparation deadline passed.', 'expired_cue');
      window.cue = revisedCue; window.desired = revisedDesired; window.deadline = revisedDesired - 5;
      const remainingAtStart = source?.loop ? Infinity : (source?.duration || 0) - (source?.position || 0) - Math.max(0, window.desired - this.engine.getAudioTime());
      if (remainingAtStart < decision.duration_seconds + 2) return reject('Transition duration does not fit before the source ends.', 'unsafe_duration');
    }
    const plan: Plan = { trackId: track.id, style: decision.type === 'transition' ? decision.style : 'crossfade', duration: decision.type === 'transition' ? decision.duration_seconds : 4, explanation: decision.explanation, fallback: false, prepared: false, preparing: true, requestId };
    window.chosen = plan; this.clearRequest(false);
    this.trace(requestId, `Agent explanation: ${decision.explanation}`, JSON.stringify({ decision, modelLatencyMs: Math.round(this.clock.now() - this.requestStarted) }), 'accepted');
    this.trace(requestId, `Preparing ${track.title}.`, undefined, 'preparing');
    this.phase = 'preparing'; this.line = `Preparing ${track.title}.`; this.publish();
    void this.prepareChoice(window, epoch, plan, requestId, track.title);
    return { accepted: true, message: 'Decision accepted for preparation. Playback has not started.' };
  }
  private async prepareChoice(window: Window, epoch: number, plan: Plan, requestId: string, title: string) {
    const started = this.clock.now();
    const result = await this.engine.prepareTrack(plan.trackId);
    if (!this.windowIsCurrent(window, epoch) || window.chosen !== plan || window.committed) return;
    plan.preparing = false;
    if (!result.ok) { this.unavailable.add(plan.trackId); window.chosen = null; this.trace(requestId, `Could not prepare ${title}; local fallback selected.`, result.message, 'failed'); if (!window.sourcePlaybackId && window.fallback) void this.commitColdStart(window, result.message); this.publish(); return; }
    plan.prepared = true; this.phase = 'ready'; this.line = window.sourcePlaybackId ? `Playing now. Next: ${title} in ${Math.round(Math.max(0, window.desired - this.engine.getAudioTime()))}s.` : `Starting ${title}.`;
    this.trace(requestId, `${title} ready.`, `Decode ${Math.round(this.clock.now() - started)} ms.`, 'ready'); this.publish();
    if (!window.sourcePlaybackId) void this.commitColdStart(window, 'Agent choice prepared.');
  }
  private async commitColdStart(window: Window, reason: string) {
    if (this.window !== window || this.mode !== 'running' || window.committed) return;
    const plan = window.chosen?.prepared ? window.chosen : window.fallback;
    if (!plan?.prepared) return;
    const epoch = this.epoch; window.committed = true; this.phase = 'transitioning'; this.line = `Starting ${this.tracks().find(t => t.id === plan.trackId)?.title || plan.trackId}.`; this.publish();
    if (plan.fallback) this.trace(window.id, `Local fallback: ${reason}`, `Starting ${plan.trackId}.`, 'scheduled');
    const result = await this.engine.commitStart(plan.trackId);
    if (this.epoch !== epoch || this.mode !== 'running') return;
    if (!result.ok) { this.unavailable.add(plan.trackId); window.committed = false; window.chosen = null; window.fallback = null; void this.prepareFallback(window); this.trace(window.id, 'Starting track failed.', result.message, 'failed'); }
  }
  tick() {
    if (this.mode !== 'running') return;
    if (this.engine.getState().transition) { if (this.window?.committed) return; }
    const window = this.window;
    if (!window) { this.adopt(); return; }
    if (window.committed) return;
    if (!window.sourcePlaybackId) {
      if (!window.requested && !this.requestId) this.request(window, 'cold_start');
      if (window.unavailableSince !== undefined && this.clock.now() - window.unavailableSince >= 1000 && window.fallback?.prepared) void this.commitColdStart(window, 'Agent connection did not become ready.');
      return;
    }
    if (this.source()?.playbackId !== window.sourcePlaybackId) { this.adopt(); return; }
    const now = this.engine.getAudioTime();
    if (!window.requested && now >= window.planning) this.request(window, 'planning');
    if (this.requestId && now >= window.deadline) this.failRequest(window, this.epoch, this.requestId, 'Preparation deadline passed.');
    if (!window.committed && window.fade >= 1 && now >= window.desired - COMMIT_LEAD) {
      const plan = window.chosen?.prepared ? window.chosen : window.fallback;
      if (!plan?.prepared) { this.line = 'Next track is not ready. Current audio continues if possible.'; this.publish(); return; }
      window.committed = true; this.clearRequest();
      const targetDuration = this.engine.getTrackAnalysis?.(plan.trackId)?.durationSeconds.value ?? Infinity;
      const targetAnalysis = this.engine.getTrackAnalysis?.(plan.trackId) || null;
      const offset = incomingCueOffset(plan.trackId, targetDuration, targetAnalysis, this.tracks().find(t => t.id === plan.trackId)?.loop ?? true);
      const result = this.engine.commitTransition({ type: 'transition', track_id: plan.trackId, style: plan.style, duration_seconds: plan.duration }, Math.max(now + 0.01, window.desired), offset);
      if (result.ok) { this.phase = 'transitioning'; this.line = `Moving into ${this.tracks().find(t => t.id === plan.trackId)?.title || plan.trackId}.`; this.trace(window.id, `${plan.fallback ? 'Local fallback' : 'Agent move'} scheduled: ${plan.trackId}.`, JSON.stringify({ plan, targetAudioTime: window.desired }), 'scheduled'); }
      else { window.committed = false; if (plan === window.chosen && window.fallback?.prepared) { window.chosen = null; this.trace(window.id, 'Agent move failed; trying local fallback.', result.message, 'failed'); } else { this.pause(`Transition failed: ${result.message}`); } }
      this.publish();
    }
    if (this.getStatus().secondsUntilNext !== null && Math.floor(now * 2) !== Math.floor((now - 0.1) * 2)) this.publish();
  }
  private lifecycle(event: AudioLifecycleEvent) {
    if (event.type === 'audio_suspended') { this.cancelManualCue(); this.pause('Audio was suspended. Resume Autopilot explicitly.'); return; }
    if (event.type === 'started') {
      this.history.push({ trackId: event.trackId, playbackId: event.playbackId, playedSeconds: 0 }); this.history = this.history.slice(-10);
      this.trace(event.playbackId, `Started ${event.trackId}.`, JSON.stringify({ audioTime: event.audioTime, playbackId: event.playbackId }), 'started');
      if (this.mode === 'running' && (!this.window?.sourcePlaybackId || this.window.committed && !this.engine.getState().transition)) this.adopt();
    }
    if (event.type === 'transition_started') this.trace(event.transitionId, 'Transition started.', JSON.stringify({ ...event, startTimingErrorMs: this.window?.committed ? Math.round((event.audioTime - this.window.desired) * 1000) : null }), 'started');
    if (event.type === 'transition_completed') { this.trace(event.transitionId, 'Transition completed.', JSON.stringify(event), 'completed'); if (this.mode === 'running') { this.window = null; this.adopt(); } }
    if (event.type === 'ended' && event.reason === 'natural' && this.mode === 'running' && this.window?.sourcePlaybackId === event.playbackId) {
      this.trace(event.playbackId, 'Track ended naturally.', undefined, 'completed');
      const window = this.window; this.window = null;
      this.clearRequest();
      if (window.fallback?.prepared) {
        const next: Window = { id: `${this.sessionId}:natural-recovery:${event.playbackId}`, sourcePlaybackId: null, baseDesired: 0, desired: 0, cue: null, deadline: Infinity, planning: 0, fade: 4, requested: true, deferred: false, committed: false, fallback: window.fallback, chosen: null, recovery: true };
        this.window = next;
        void this.commitColdStart(next, 'Natural end reached.');
      }
      else this.coldStart();
    }
    if (event.type === 'ended') {
      const item = this.history.find(entry => entry.playbackId === event.playbackId);
      if (item) item.playedSeconds = Math.max(item.playedSeconds, this.engine.getState().decks[event.deck].playedSeconds);
    }
  }
}
