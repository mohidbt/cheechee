import type { DeckState, TrackAnalysis, TrackCueSet } from '../../shared/contracts';
import { demoCueSets } from '../../shared/catalog';

export type CueOccurrence = { fileSeconds: number; playedSeconds: number; secondsUntil: number; kind: string; provenance: 'manual' | 'estimated'; reviewed: boolean; label: string; alignment: 'estimated_beat_grid' | 'reviewed_pulse_grid' | 'window_center' };

export function cueSetFor(trackId: string | null): TrackCueSet | null { return trackId ? demoCueSets[trackId] || null : null; }

export function usableBeatGrid(deck: Pick<DeckState, 'loop' | 'duration'>, analysis: TrackAnalysis | null): boolean {
  const bpm = analysis?.estimatedTempo?.bpm;
  return !!bpm && bpm >= 40 && bpm <= 240 && (!deck.loop || Math.abs(deck.duration * bpm / 60 - Math.round(deck.duration * bpm / 60)) <= 0.12);
}

export function incomingCueOffset(trackId: string, durationSeconds: number, analysis: TrackAnalysis | null = null, loop = true): number {
  const cue = cueSetFor(trackId);
  if (cue && cue.cueInSeconds >= 0 && cue.cueInSeconds < durationSeconds - 0.2) return cue.cueInSeconds;
  const estimated = analysis?.estimatedTempo?.firstBeatOffsetSeconds;
  return estimated !== undefined && usableBeatGrid({ loop, duration: durationSeconds }, analysis) && estimated >= 0 && estimated < durationSeconds - 0.2 ? estimated : 0;
}

function playbackOffset(deck: DeckState): number {
  if (!deck.duration) return 0;
  const offset = deck.position - deck.playedSeconds;
  return deck.loop ? ((offset % deck.duration) + deck.duration) % deck.duration : Math.max(0, offset);
}

function snappedFileSecond(start: number, end: number, deck: DeckState, analysis: TrackAnalysis | null): { second: number; alignment: CueOccurrence['alignment'] } {
  const reviewed = cueSetFor(deck.trackId)?.reviewedPulseGrid;
  if (reviewed) {
    const beat = 60 / reviewed.bpm;
    const n = Math.round(((start + end) / 2 - reviewed.firstPulseSeconds) / beat);
    const second = reviewed.firstPulseSeconds + n * beat;
    if (second >= start && second <= end) return { second, alignment: 'reviewed_pulse_grid' };
  }
  const estimate = analysis?.estimatedTempo;
  if (estimate && usableBeatGrid(deck, analysis)) {
    const beat = 60 / estimate.bpm;
    const first = estimate.firstBeatOffsetSeconds;
    const n = Math.round(((start + end) / 2 - first) / beat);
    const candidate = first + n * beat;
    if (candidate >= start && candidate <= end) return { second: candidate, alignment: 'estimated_beat_grid' };
  }
  return { second: (start + end) / 2, alignment: 'window_center' };
}

export function upcomingCueExits(deck: DeckState, analysis: TrackAnalysis | null, horizonSeconds = 120): CueOccurrence[] {
  const cues = cueSetFor(deck.trackId);
  if (deck.status !== 'playing' || !deck.playbackId || deck.duration <= 0) return [];
  const offset = playbackOffset(deck);
  const out: CueOccurrence[] = [];
  if (!cues && usableBeatGrid(deck, analysis)) {
    const bpm = analysis!.estimatedTempo!.bpm;
    const beat = 60 / bpm;
    const first = analysis!.estimatedTempo!.firstBeatOffsetSeconds;
    const initialCycle = deck.loop ? Math.floor((deck.playedSeconds + offset) / deck.duration) : 0;
    const cycles = deck.loop ? Math.ceil(horizonSeconds / deck.duration) + 2 : 1;
    for (let cycle = initialCycle; cycle < initialCycle + cycles; cycle++) {
      for (let index = 0; first + index * beat < deck.duration - 0.15; index++) {
        const fileSeconds = first + index * beat;
        const playedSeconds = fileSeconds - offset + cycle * deck.duration;
        const secondsUntil = playedSeconds - deck.playedSeconds;
        if (secondsUntil < 0 || secondsUntil > horizonSeconds) continue;
        out.push({ fileSeconds, playedSeconds, secondsUntil, kind: 'estimated_beat', provenance: 'estimated', reviewed: false, label: 'Estimated beat start', alignment: 'estimated_beat_grid' });
      }
    }
    return out.sort((a, b) => a.secondsUntil - b.secondsUntil);
  }
  if (!cues) return [];
  for (const cue of cues.exits) {
    if (!cue.reviewed || cue.fileSeconds < 0 || cue.endSeconds > deck.duration - 0.1 || cue.endSeconds <= cue.fileSeconds) continue;
    const snap = snappedFileSecond(cue.fileSeconds, cue.endSeconds, deck, analysis);
    const firstCycle = deck.loop ? Math.floor((deck.playedSeconds + offset - snap.second) / deck.duration) : 0;
    const lastCycle = deck.loop ? firstCycle + Math.ceil(horizonSeconds / deck.duration) + 2 : 0;
    for (let cycle = Math.max(0, firstCycle); cycle <= lastCycle; cycle++) {
      const playedSeconds = snap.second - offset + cycle * deck.duration;
      const secondsUntil = playedSeconds - deck.playedSeconds;
      if (secondsUntil < 0 || secondsUntil > horizonSeconds) continue;
      out.push({ fileSeconds: snap.second, playedSeconds, secondsUntil, kind: cue.kind, provenance: cue.provenance, reviewed: true, label: cue.label, alignment: snap.alignment });
    }
  }
  return out.sort((a, b) => a.secondsUntil - b.secondsUntil);
}

export function selectExitCue(deck: DeckState, analysis: TrackAnalysis | null, targetPlayedSeconds: number, fadeSeconds: number, minLeadSeconds = 0.25): CueOccurrence | null {
  if (!Number.isFinite(targetPlayedSeconds) || fadeSeconds < 1 || fadeSeconds > 12) return null;
  return upcomingCueExits(deck, analysis, Math.max(120, targetPlayedSeconds - deck.playedSeconds + 12))
    .filter(cue => cue.secondsUntil >= minLeadSeconds && cue.fileSeconds + fadeSeconds <= deck.duration - 0.15)
    .filter(cue => Math.abs(cue.playedSeconds - targetPlayedSeconds) <= 8)
    .sort((a, b) => Math.abs(a.playedSeconds - targetPlayedSeconds) - Math.abs(b.playedSeconds - targetPlayedSeconds))[0] || null;
}
