import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyState, type AudioEngine, type AudioLifecycleEvent, type AudioTrack, type DecisionAck, type ServerMessage } from '../shared/contracts';
import { demoCueSets } from '../shared/catalog';
import { AutopilotController, type AutopilotClock, type AutopilotTransport } from '../src/autopilot/controller';

const tracks: AudioTrack[] = [
  { id: 'a', title: 'A', artist: 'Test', tags: [], energy: 'unknown', source: 'bundled', loop: true, url: '/a.wav' },
  { id: 'b', title: 'B', artist: 'Test', tags: [], energy: 'unknown', source: 'bundled', loop: true, url: '/b.wav' },
  { id: 'c', title: 'C', artist: 'Test', tags: [], energy: 'unknown', source: 'local', loop: false, url: '/c.wav' },
];
function harness(blockedTrack?: string) {
  const catalogue = tracks.map(track => ({ ...track }));
  const state = emptyState(); state.unlocked = true;
  let audioTime = 0;
  let wall = 0;
  let sequence = 0;
  let lifecycle: (event: AudioLifecycleEvent) => void = () => {};
  const prepared: string[] = [];
  const starts: string[] = [];
  const transitions: string[] = [];
  const durations: number[] = [];
  const requests: Array<{ request: Parameters<AutopilotTransport['requestAutonomy']>[0]; decide: (reply: Extract<ServerMessage, { type: 'dj_decision' }>) => Promise<DecisionAck>; fail: (reason: string) => void }> = [];
  let cancellations = 0;
  let transportAvailable = true;
  let unblock: (() => void) | undefined;
  const timers = new Map<number, { at: number; fn: () => void }>(); let timerId = 0;
  const intervals = new Map<number, () => void>();
  const clock: AutopilotClock = { now: () => wall, setInterval: fn => { const id = ++timerId; intervals.set(id, fn); return id as unknown as ReturnType<typeof setInterval>; }, clearInterval: id => { intervals.delete(Number(id)); }, setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { at: wall + ms, fn }); return id as unknown as ReturnType<typeof setTimeout>; }, clearTimeout: id => { timers.delete(Number(id)); } };
  const engine = {
    getState: () => ({ ...state, audioTime }), getAudioTime: () => audioTime,
    subscribeLifecycle: (listener: typeof lifecycle) => { lifecycle = listener; return () => { lifecycle = () => {}; }; },
    prepareTrack: async (id: string) => { prepared.push(id); if (id === blockedTrack) await new Promise<void>(resolve => { unblock = resolve; }); return { ok: true, message: 'ready' }; },
    commitStart: async (id: string) => { starts.push(id); state.decks.A = { ...state.decks.A, trackId: id, status: 'playing', playbackId: `play-${++sequence}`, loop: true, duration: 12 }; lifecycle({ type: 'started', deck: 'A', trackId: id, playbackId: state.decks.A.playbackId!, audioTime }); return { ok: true, message: 'started' }; },
    commitTransition: (command: { track_id: string; duration_seconds: number }) => { transitions.push(command.track_id); durations.push(command.duration_seconds); state.transition = { id: 'fade', from: 'A', to: 'B', style: 'crossfade', progress: 0 }; return { ok: true, message: 'scheduled', scheduled: true }; },
  } as unknown as AudioEngine;
  const transport: AutopilotTransport = { requestAutonomy: (request, decide, fail) => { if (!transportAvailable) return false; requests.push({ request, decide, fail }); return true; }, cancelAutonomy: () => { cancellations++; } };
  const events: string[] = [];
  const controller = new AutopilotController(engine, transport, () => catalogue, () => {}, event => events.push(event.text), clock);
  const advance = (seconds: number) => { audioTime += seconds; wall += seconds * 1000; state.decks.A.playedSeconds += seconds; state.decks.A.position = (state.decks.A.position + seconds) % 12; for (const [id, timer] of [...timers]) if (timer.at <= wall) { timers.delete(id); timer.fn(); } controller.tick(); };
  return { controller, catalogue, state, requests, starts, transitions, durations, prepared, events, advance, setTransportAvailable: (available: boolean) => { transportAvailable = available; }, runIntervals: () => { for (const fn of [...intervals.values()]) fn(); }, unblock: () => unblock?.(), emit: (event: AudioLifecycleEvent) => lifecycle(event), get cancellations() { return cancellations; } };
}
const reply = (request: ReturnType<typeof harness>['requests'][number], decision: Extract<ServerMessage, {type:'dj_decision'}>['decision']) => ({ type: 'dj_decision' as const, requestId: request.request.requestId, decisionId: 'd1', sessionId: request.request.sessionId, controlRevision: request.request.controlRevision, sourcePlaybackId: request.request.sourcePlaybackId, decision });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('Autopilot controller', () => {
  it('acknowledges a cold choice before playback and starts only after preparation', async () => {
    const h = harness(); expect(h.controller.enable()).toBe(true); expect(h.requests).toHaveLength(1);
    const ack = await h.requests[0].decide(reply(h.requests[0], { type: 'start', track_id: 'b', explanation: 'A varied opening.' }));
    expect(ack).toMatchObject({ accepted: true });
    await flush();
    expect(h.prepared).toContain('b'); expect(h.starts).toContain('b');
    expect(h.controller.getHistory().map(item => item.trackId)).toEqual(['b']);
    h.controller.dispose();
  });
  it('uses one decision window for a looping clip and rejects stale decisions after manual pause', async () => {
    const h = harness(); h.state.decks.A = { ...h.state.decks.A, trackId: 'a', playbackId: 'source', status: 'playing', loop: true, duration: 12 };
    h.controller.setChangeInterval(60); h.controller.enable(); await flush(); h.advance(35); expect(h.requests).toHaveLength(1);
    h.advance(8); expect(h.requests).toHaveLength(1);
    h.controller.pause();
    const ack = await h.requests[0].decide(reply(h.requests[0], { type: 'transition', track_id: 'b', style: 'crossfade', duration_seconds: 4, explanation: 'Moving ahead.' }));
    expect(ack.accepted).toBe(false); expect(h.transitions).toHaveLength(0);
    h.controller.dispose();
  });
  it('commits a prepared fallback after decision timeout without another model request', async () => {
    const h = harness(); h.state.decks.A = { ...h.state.decks.A, trackId: 'a', playbackId: 'source', status: 'playing', loop: true, duration: 12 };
    h.controller.setChangeInterval(60); h.controller.enable(); await flush(); h.advance(35); expect(h.requests).toHaveLength(1);
    h.advance(10); expect(h.cancellations).toBe(1);
    h.advance(14.9); expect(h.transitions).toEqual(['b']); expect(h.requests).toHaveLength(1);
    h.controller.dispose();
  });
  it('moves the planning window when wait is accepted and rejects a second wait', async () => {
    const h = harness(); h.state.decks.A = { ...h.state.decks.A, trackId: 'a', playbackId: 'source', status: 'playing', loop: true, duration: 12 };
    h.controller.setChangeInterval(60); h.controller.enable(); await flush(); h.advance(35);
    const first = h.requests[0];
    expect((await first.decide(reply(first, { type: 'wait', defer_seconds: 15, explanation: 'Stay with this groove.' }))).accepted).toBe(true);
    expect(h.controller.getContext().remainder?.residenceSeconds).toBeCloseTo(40);
    h.advance(14.9); expect(h.requests).toHaveLength(1);
    h.advance(0.1); expect(h.requests).toHaveLength(2);
    const second = h.requests[1];
    expect((await second.decide(reply(second, { type: 'wait', defer_seconds: 15, explanation: 'Wait again.' }))).accepted).toBe(false);
    h.controller.dispose();
  });
  it('uses a prepared fallback at natural end without starting an unnecessary new request', async () => {
    const h = harness(); h.catalogue[0] = { ...h.catalogue[0], source: 'local', loop: false }; h.state.decks.A = { ...h.state.decks.A, trackId: 'a', playbackId: 'source', status: 'playing', loop: false, duration: 60 };
    h.controller.setChangeInterval(60); h.controller.enable(); await flush();
    h.state.decks.A.status = 'stopped'; h.state.decks.A.playbackId = null;
    h.emit({ type: 'ended', deck: 'A', trackId: 'a', playbackId: 'source', audioTime: 60, reason: 'natural' });
    await flush(); expect(h.starts).toEqual(['b']); expect(h.requests).toHaveLength(0);
    h.controller.dispose();
  });
  it('does not adopt an incoming deck before a committed transition completes', async () => {
    const h = harness();
    h.state.decks.A = { ...h.state.decks.A, trackId: 'a', playbackId: 'incoming', status: 'playing', loop: true, duration: 12 };
    h.state.decks.B = { ...h.state.decks.B, trackId: 'b', playbackId: 'outgoing', status: 'playing', loop: true, duration: 12 };
    h.state.transition = { id: 'fade', from: 'B', to: 'A', style: 'crossfade', progress: 0.5 };
    h.controller.enable(); h.advance(35); expect(h.requests).toHaveLength(0);
    h.state.transition = null; h.state.decks.B.status = 'stopped';
    h.emit({ type: 'transition_completed', transitionId: 'fade', from: 'B', to: 'A', fromPlaybackId: 'outgoing', toPlaybackId: 'incoming', audioTime: 35 });
    expect(h.controller.getContext().now?.playbackId).toBe('incoming');
    h.controller.dispose();
  });
  it('ignores a slow chosen decode after the ready fallback was committed', async () => {
    const h = harness('c'); h.state.decks.A = { ...h.state.decks.A, trackId: 'a', playbackId: 'source', status: 'playing', loop: true, duration: 12 };
    h.controller.setChangeInterval(60); h.controller.enable(); await flush(); h.advance(35);
    const request = h.requests[0];
    expect((await request.decide(reply(request, { type: 'transition', track_id: 'c', style: 'echo', duration_seconds: 4, explanation: 'Try the local song.' }))).accepted).toBe(true);
    h.advance(24.9); expect(h.transitions).toEqual(['b']);
    h.unblock(); await flush();
    expect(h.controller.getStatus().phase).toBe('transitioning');
    expect(h.transitions).toEqual(['b']);
    h.controller.dispose();
  });
  it('honors a twelve-second loop transition and rejects an unsafe full-song duration', async () => {
    const loop = harness(); loop.state.decks.A = { ...loop.state.decks.A, trackId: 'a', playbackId: 'loop', status: 'playing', loop: true, duration: 12 };
    loop.controller.setChangeInterval(60); loop.controller.enable(); await flush(); loop.advance(35);
    const first = loop.requests[0];
    expect((await first.decide(reply(first, { type: 'transition', track_id: 'b', style: 'filter', duration_seconds: 12, explanation: 'A long fade.' }))).accepted).toBe(true);
    await flush(); loop.advance(24.9); expect(loop.durations).toEqual([12]); loop.controller.dispose();

    const song = harness(); song.state.decks.A = { ...song.state.decks.A, trackId: 'a', playbackId: 'song', status: 'playing', loop: false, duration: 60 };
    song.controller.setChangeInterval(60); song.controller.enable(); await flush(); song.advance(29); song.state.decks.A.position = 29;
    const second = song.requests[0];
    expect(await second.decide(reply(second, { type: 'transition', track_id: 'b', style: 'filter', duration_seconds: 12, explanation: 'A long fade.' }))).toMatchObject({ accepted: false, code: 'unsafe_duration' });
    song.controller.dispose();
  });
  it('leaves loop residence unknown when there is no active Autopilot plan', () => {
    const h = harness(); h.state.decks.A = { ...h.state.decks.A, trackId: 'a', playbackId: 'manual', status: 'playing', loop: true, duration: 12 };
    expect(h.controller.getContext().remainder?.residenceSeconds).toBeNull();
    h.controller.dispose();
  });
});

describe('user-selected change interval', () => {
  it('targets 20 seconds by default, asks immediately, and keeps one request while fallback starts', async () => {
    const h = harness(); h.state.decks.A = { ...h.state.decks.A, trackId: 'a', playbackId: 'source', status: 'playing', loop: true, duration: 12 };
    h.controller.enable(); await flush();
    expect(h.controller.getStatus().changeIntervalSeconds).toBe(20);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].request.desiredInSeconds).toBeCloseTo(20);
    expect(h.requests[0].request.context.requestedChangeIntervalSeconds).toBe(20);
    h.advance(10); expect(h.cancellations).toBe(1);
    h.advance(9.9); expect(h.transitions).toEqual(['b']); expect(h.requests).toHaveLength(1);
    h.controller.dispose();
  });
  it('allows a longer pace and invalidates a previous decision when changed during playback', async () => {
    const h = harness(); h.state.decks.A = { ...h.state.decks.A, trackId: 'a', playbackId: 'source', status: 'playing', loop: true, duration: 12 };
    h.controller.enable(); await flush(); const old = h.requests[0];
    h.advance(5); h.controller.setChangeInterval(60);
    expect(h.cancellations).toBe(1);
    expect(h.controller.getStatus().secondsUntilNext).toBeCloseTo(55);
    expect(h.controller.getContext().requestedChangeIntervalSeconds).toBe(60);
    expect((await old.decide(reply(old, { type: 'transition', track_id: 'b', style: 'crossfade', duration_seconds: 4, explanation: 'Old plan.' }))).accepted).toBe(false);
    h.advance(29.9); expect(h.requests).toHaveLength(1);
    h.advance(0.1); expect(h.requests).toHaveLength(2);
    expect(h.requests[1].request.desiredInSeconds).toBeCloseTo(25);
    h.controller.setChangeInterval(120);
    h.advance(59.9); expect(h.requests).toHaveLength(2);
    h.advance(0.1); expect(h.requests).toHaveLength(3);
    expect(h.requests[2].request.context.requestedChangeIntervalSeconds).toBe(120);
    h.controller.dispose();
  });
  it('uses a prepared local move when a short song cannot fit the model budget, and never fades an unsafe tiny clip', async () => {
    const short = harness(); short.state.decks.A = { ...short.state.decks.A, trackId: 'a', playbackId: 'short', status: 'playing', loop: false, duration: 12 };
    short.controller.enable(); await flush(); expect(short.requests).toHaveLength(0);
    expect(short.controller.getStatus().secondsUntilNext).toBeCloseTo(6);
    short.advance(5.9); expect(short.transitions).toEqual(['b']); short.controller.dispose();
    const tiny = harness(); tiny.state.decks.A = { ...tiny.state.decks.A, trackId: 'a', playbackId: 'tiny', status: 'playing', loop: false, duration: 2 };
    tiny.controller.enable(); await flush(); tiny.advance(1.9);
    expect(tiny.requests).toHaveLength(0); expect(tiny.transitions).toHaveLength(0);
    tiny.controller.dispose();
  });
});

describe('temporary agent unavailability', () => {
  it('retries the same playback window when the connection opens and sends only one decision request', async () => {
    const h = harness(); h.setTransportAvailable(false);
    h.state.decks.A = { ...h.state.decks.A, trackId: 'a', playbackId: 'source', status: 'playing', loop: true, duration: 12 };
    h.controller.enable(); await flush();
    expect(h.requests).toHaveLength(0);
    expect(h.events.filter(event => event.includes('Waiting for the agent'))).toHaveLength(1);
    h.advance(0.2); expect(h.requests).toHaveLength(0);
    h.setTransportAvailable(true); h.advance(0.1);
    expect(h.requests).toHaveLength(1);
    h.advance(0.1); expect(h.requests).toHaveLength(1);
    h.controller.dispose();
  });
});

describe('manual reviewed cue scheduling', () => {
  beforeEach(() => { demoCueSets['fixture-loop'] = {cueInSeconds:0.11,cueInLabel:'Reviewed test pulse',reviewedPulseGrid:{bpm:140,firstPulseSeconds:0.11,provenance:'manual',reviewed:true},exits:[{fileSeconds:2.45,endSeconds:2.75,kind:'loop_exit',provenance:'manual',reviewed:true,label:'Test loop exit'}]}; });
  afterEach(() => { delete demoCueSets['fixture-loop']; });
  const command = { type: 'transition' as const, track_id: 'b', style: 'crossfade' as const, duration_seconds: 2, timing: 'next_cue' as const };
  it('prepares, acknowledges a future reviewed cue, then commits only near its audio time', async () => {
    const h = harness();
    h.state.decks.A = { ...h.state.decks.A, trackId: 'fixture-loop', playbackId: 'source', status: 'playing', loop: true, duration: 6.875, position: 1, playedSeconds: 1 };
    const result = await h.controller.scheduleManualCue(command);
    expect(result).toMatchObject({ ok: true, scheduled: true });
    expect(h.transitions).toHaveLength(0);
    h.advance(1.55); h.runIntervals();
    expect(h.transitions).toEqual(['b']);
    h.controller.dispose();
  });
  it('cancels a pending cue on Stop all and rejects ambiguous two-deck playback', async () => {
    const h = harness();
    h.state.decks.A = { ...h.state.decks.A, trackId: 'fixture-loop', playbackId: 'source', status: 'playing', loop: true, duration: 6.875, position: 1, playedSeconds: 1 };
    expect((await h.controller.scheduleManualCue(command)).scheduled).toBe(true);
    h.controller.stopAll(); h.advance(2); h.runIntervals(); expect(h.transitions).toHaveLength(0);
    h.state.decks.B = { ...h.state.decks.B, trackId: 'a', playbackId: 'other', status: 'playing', loop: true, duration: 12 };
    expect((await h.controller.scheduleManualCue(command)).code).toBe('no_source');
    h.controller.dispose();
  });
});
