import { describe, expect, it } from 'vitest';
import { emptyState } from '../shared/contracts';
import { CLIP_FILES, clipForLifecycle, clipForLoad, clipForMixerChange, idleClipForState, videoUrl } from '../src/video/clips';

describe('performance clip mapping', () => {
  it('only references the copied real clips', () => {
    expect(Object.keys(CLIP_FILES)).toHaveLength(18);
    expect(videoUrl('idle')).toBe('/video/idle.mp4');
    expect(videoUrl('idle_hype')).toBe('/video/idle_hype.mp4');
    expect(Object.values(CLIP_FILES)).not.toContain('filter_sweep.mp4');
  });

  it('uses actual deck identity and cue position for playback', () => {
    const state = emptyState();
    state.decks.B.status = 'playing';
    state.decks.B.position = 1.25;
    expect(clipForLifecycle({type:'started', deck:'B', trackId:'next', playbackId:'one', audioTime:1}, state)).toBe('needle_drop_b');
    state.decks.B.position = 0;
    expect(clipForLifecycle({type:'started', deck:'B', trackId:'next', playbackId:'two', audioTime:2}, state)).toBe('start_b');
    state.transition = {id:'fade', from:'A', to:'B', style:'crossfade', progress:0};
    expect(clipForLifecycle({type:'started', deck:'B', trackId:'next', playbackId:'three', audioTime:3}, state)).toBeNull();
    expect(clipForLifecycle({type:'transition_started', transitionId:'fade', from:'A', to:'B', fromPlaybackId:'source', toPlaybackId:'three', audioTime:3}, state)).toBe('crossfade_to_b');
    expect(clipForLifecycle({type:'ended', deck:'A', trackId:'old', playbackId:'source', audioTime:4, reason:'transition'}, state)).toBeNull();
  });

  it('maps successful load/swap and manual mixer changes without transition ramp noise', () => {
    expect(clipForLoad('A', false)).toBe('load_a');
    expect(clipForLoad('B', true)).toBe('swap_b');
    const first = emptyState(), next = emptyState();
    expect(idleClipForState(first)).toBe('idle');
    next.decks.A.status = 'playing';
    expect(idleClipForState(next)).toBe('idle_hype');
    expect(clipForMixerChange(first, {...first, crossfader: 0.5})).toBeNull();
    next.decks.A.eq.low = -8;
    expect(clipForMixerChange(first, next)).toBe('eq_low');
    next.decks.A.eq.low = 0; next.decks.B.eq.high = 2;
    expect(clipForMixerChange(first, next)).toBe('eq_mid');
    next.decks.B.eq.high = 0; next.decks.B.volume = 0.4;
    expect(clipForMixerChange(first, next)).toBe('fader_down_b');
    next.decks.B.volume = 0.8; next.crossfader = 0.5;
    expect(clipForMixerChange(first, next)).toBe('crossfade_to_b');
    next.transition = {id:'fade', from:'A', to:'B', style:'filter', progress:0.5};
    expect(clipForMixerChange(first, next)).toBeNull();
  });
});
