import type { AudioLifecycleEvent, DeckId, DJState } from '../../shared/contracts';

export const CLIP_FILES = {
  idle: 'idle.mp4',
  idle_hype: 'idle_hype.mp4',
  load_a: 'load_a.mp4', load_b: 'load_b.mp4',
  swap_a: 'swap_a.mp4', swap_b: 'swap_b.mp4',
  start_a: 'start_a.mp4', start_b: 'start_b.mp4',
  needle_drop_a: 'needle_drop_a.mp4', needle_drop_b: 'needle_drop_b.mp4',
  crossfade_to_a: 'crossfade_to_a.mp4', crossfade_to_b: 'crossfade_to_b.mp4',
  fader_up_a: 'fader_up_a.mp4', fader_up_b: 'fader_up_b.mp4',
  fader_down_a: 'fader_down_a.mp4', fader_down_b: 'fader_down_b.mp4',
  eq_low: 'eq_low.mp4', eq_mid: 'eq_mid.mp4',
} as const;

export type VideoClipId = keyof typeof CLIP_FILES;
export const QUIET_IDLE_CLIP = 'idle' as const;
export const IDLE_CLIP = 'idle_hype' as const;
export const videoUrl = (clip: VideoClipId) => `/video/${CLIP_FILES[clip]}`;
export const hasPlayingDeck = (state: DJState) => state.decks.A.status === 'playing' || state.decks.B.status === 'playing';
export const idleClipForState = (state: DJState): VideoClipId => hasPlayingDeck(state) ? IDLE_CLIP : QUIET_IDLE_CLIP;
const onDeck = (prefix: string, deck: DeckId) => `${prefix}_${deck.toLowerCase()}` as VideoClipId;

export function clipForLoad(deck: DeckId, replacing: boolean): VideoClipId {
  return onDeck(replacing ? 'swap' : 'load', deck);
}

export function clipForLifecycle(event: AudioLifecycleEvent, state: DJState): VideoClipId | null {
  if (!hasPlayingDeck(state)) return null;
  if (event.type === 'transition_started') return onDeck('crossfade_to', event.to);
  if (event.type === 'started') {
    if (state.transition) return null;
    return onDeck(state.decks[event.deck].position > 0.02 ? 'needle_drop' : 'start', event.deck);
  }
  if (event.type === 'ended' && event.reason === 'stopped') return onDeck('fader_down', event.deck);
  return null;
}

/** Only manual mixer changes animate here; transition ramps are lifecycle driven. */
export function clipForMixerChange(previous: DJState, next: DJState): VideoClipId | null {
  if (!hasPlayingDeck(next)) return null;
  if (previous.transition || next.transition) return null;
  if (Math.abs(next.crossfader - previous.crossfader) >= 0.04) return onDeck('crossfade_to', next.crossfader > previous.crossfader ? 'B' : 'A');
  for (const deck of ['A', 'B'] as const) {
    const a = previous.decks[deck], b = next.decks[deck];
    if (a.eq.low !== b.eq.low || a.filter.mode !== b.filter.mode || a.filter.frequency !== b.filter.frequency) return 'eq_low';
    if (a.eq.mid !== b.eq.mid || a.eq.high !== b.eq.high) return 'eq_mid';
    if (Math.abs(b.volume - a.volume) >= 0.005) return onDeck(b.volume > a.volume ? 'fader_up' : 'fader_down', deck);
  }
  return null;
}
