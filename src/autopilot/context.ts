import type { AudioTrack, DJState, MusicalContext, PlayedTrack, TrackAnalysis } from '../../shared/contracts';
import { upcomingCueExits } from './cues';

export const DEFAULT_OBJECTIVE = 'Play a varied electronic set. Keep energy broadly steady, avoid immediate repeats, and prefer smooth transitions.';
export const DEFAULT_CHANGE_INTERVAL_SECONDS = 20;

export type PendingMove = MusicalContext['pending'];

export function buildMusicalContext(
  state: DJState,
  catalogue: AudioTrack[],
  objective: string,
  history: PlayedTrack[],
  pending: PendingMove = null,
  plannedResidenceSeconds?: number,
  analysisForTrack: (trackId: string) => TrackAnalysis | null = () => null,
  requestedChangeIntervalSeconds = DEFAULT_CHANGE_INTERVAL_SECONDS,
): MusicalContext {
  const source = state.transition && state.decks[state.transition.from].status === 'playing'
    ? state.transition.from
    : (['A', 'B'] as const).find(id => state.decks[id].status === 'playing' && state.decks[id].playbackId);
  const deck = source ? state.decks[source] : null;
  const naturalSeconds = deck && !deck.loop ? Math.max(0, deck.duration - deck.position) : null;
  const residenceSeconds = deck?.loop && plannedResidenceSeconds !== undefined ? Math.max(0, plannedResidenceSeconds) : null;
  const cues = deck ? upcomingCueExits(deck, analysisForTrack(deck.trackId || ''), 120) : [];
  return {
    state,
    objective: objective.trim().slice(0, 500) || DEFAULT_OBJECTIVE,
    requestedChangeIntervalSeconds,
    history: history.slice(-10),
    tracks: catalogue.map(({ url: _url, ...track }) => track).slice(0, 20),
    analysis: catalogue.flatMap(track => {
      const tempo = analysisForTrack(track.id)?.estimatedTempo;
      return tempo ? [{ trackId: track.id, bpm: tempo.bpm, firstBeatOffsetSeconds: tempo.firstBeatOffsetSeconds, provenance: 'estimated' as const, reviewed: false as const }] : [];
    }).slice(0, 20),
    now: source && deck && deck.trackId && deck.playbackId ? {
      deck: source, trackId: deck.trackId, playbackId: deck.playbackId,
      positionSeconds: deck.position, playedSeconds: deck.playedSeconds,
      durationSeconds: deck.duration, loop: deck.loop,
    } : null,
    upcoming: cues.filter(cue => cue.secondsUntil <= 60).slice(0, 8).map(cue => ({ kind: cue.kind, fileSeconds: cue.fileSeconds, secondsUntil: cue.secondsUntil, provenance: cue.provenance, reviewed: cue.reviewed, label: cue.label, alignment: cue.alignment })),
    remainder: deck ? { naturalSeconds, residenceSeconds, laterExits: cues.filter(cue => cue.secondsUntil > 60).slice(0, 3).map(cue => ({ fileSeconds: cue.fileSeconds, secondsUntil: cue.secondsUntil, provenance: cue.provenance, reviewed: cue.reviewed })) } : null,
    pending,
  };
}
