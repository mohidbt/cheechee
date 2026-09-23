import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyState, type TrackAnalysis } from '../shared/contracts';
import { demoCueSets } from '../shared/catalog';
import { incomingCueOffset, selectExitCue, upcomingCueExits, usableBeatGrid } from '../src/autopilot/cues';

const analysis = (duration: number, bpm: number, offset = 0): TrackAnalysis => ({
  contentKey: 'test', analysisVersion: 1,
  durationSeconds: { value: duration, provenance: 'measured' },
  rms: { windowSeconds: 0.1, values: [], provenance: 'measured' },
  estimatedTempo: { bpm, firstBeatOffsetSeconds: offset, sourceStartSeconds: 0, sourceDurationSeconds: duration, provenance: 'estimated', reviewed: false },
});
const deck = (trackId: string, duration: number, position: number, playedSeconds: number, loop = true) => ({
  ...emptyState().decks.A, trackId, duration, position, playedSeconds, loop, status: 'playing' as const, playbackId: 'p1',
});

describe('cue timing', () => {
  beforeEach(() => {
    demoCueSets['fixture-loop'] = {cueInSeconds:0.11,cueInLabel:'Reviewed test pulse',reviewedPulseGrid:{bpm:140,firstPulseSeconds:0.11,provenance:'manual',reviewed:true},exits:[{fileSeconds:2.45,endSeconds:2.75,kind:'loop_exit',provenance:'manual',reviewed:true,label:'Test loop exit'}]};
    demoCueSets['fixture-break'] = {cueInSeconds:9.11,cueInLabel:'Reviewed test pulse',reviewedPulseGrid:{bpm:140,firstPulseSeconds:0.11,provenance:'manual',reviewed:true},exits:[]};
  });
  afterEach(() => { delete demoCueSets['fixture-loop']; delete demoCueSets['fixture-break']; });
  it('maps reviewed loop windows to future cycles and requires room for the full fade', () => {
    const source = deck('fixture-loop', 6.875, 6.7, 20.45);
    const next = upcomingCueExits(source, null, 15);
    expect(next.length).toBeGreaterThan(1);
    expect(next[0].secondsUntil).toBeGreaterThan(2);
    expect(next[0].reviewed).toBe(true);
    expect(selectExitCue(source, null, source.playedSeconds + next[0].secondsUntil, 5)).toBe(null);
    expect(selectExitCue(source, null, source.playedSeconds + next[0].secondsUntil, 2)?.fileSeconds).toBeCloseTo(2.681, 2);
  });
  it('rejects inconsistent loop beat grids while preserving a nonzero reviewed incoming cue', () => {
    const source = deck('fixture-loop', 6.875, 1, 1);
    expect(usableBeatGrid(source, analysis(6.875, 117, 0.008))).toBe(false);
    expect(upcomingCueExits(source, analysis(6.875, 117, 0.008), 15)[0].alignment).toBe('reviewed_pulse_grid');
    expect(incomingCueOffset('fixture-break', 13.732, analysis(13.732, 140, 0.31))).toBe(9.11);
  });
  it('offers estimated, unreviewed beat departures for analyzed imported audio and falls back without analysis', () => {
    const source = deck('imported', 30, 3.1, 3.1, false);
    expect(upcomingCueExits(source, null, 10)).toEqual([]);
    const cues = upcomingCueExits(source, analysis(30, 120, 0.25), 10);
    expect(cues[0]).toMatchObject({ reviewed: false, provenance: 'estimated', alignment: 'estimated_beat_grid' });
    expect(selectExitCue(source, analysis(30, 120, 0.25), 9, 4)?.fileSeconds).toBeLessThan(26);
    expect(incomingCueOffset('imported', 30, analysis(30, 120, 0.25), false)).toBe(0.25);
  });
});
