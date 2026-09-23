import type { AudioTrack, TrackCueSet } from './contracts';
export const demoTracks: AudioTrack[] = [
  {id:'melodic',title:'Melodic',artist:'Fupi',tags:['melodic','electronic'],energy:'medium',source:'bundled',loop:true,url:'/audio/melodicedm.wav'},
  {id:'loopy',title:'Loopy',artist:'Fupi',tags:['steady','electronic'],energy:'low',source:'bundled',loop:true,url:'/audio/melodicloopyedm.wav'},
  {id:'skippy',title:'Skippy',artist:'Fupi',tags:['bouncy','electronic'],energy:'high',source:'bundled',loop:true,url:'/audio/melodicskippyedm.wav'},
];

// Waveform-reviewed playback points and pulse timing. Pulses are not verified
// downbeats or phrases, and matching pulse starts does not match playback speed.
export const demoCueSets: Record<string, TrackCueSet> = {
  melodic: { cueInSeconds: 0.11, cueInLabel: 'Reviewed first pulse', reviewedPulseGrid: { bpm: 140, firstPulseSeconds: 0.11, provenance: 'manual', reviewed: true }, exits: [{ fileSeconds: 2.45, endSeconds: 2.75, kind: 'loop_exit', provenance: 'manual', reviewed: true, label: 'Loop exit before file boundary' }] },
  loopy: { cueInSeconds: 0.11, cueInLabel: 'Reviewed first pulse', reviewedPulseGrid: { bpm: 140, firstPulseSeconds: 0.11, provenance: 'manual', reviewed: true }, exits: [{ fileSeconds: 2.45, endSeconds: 2.75, kind: 'loop_exit', provenance: 'manual', reviewed: true, label: 'Loop exit before file boundary' }] },
  skippy: { cueInSeconds: 9.11, cueInLabel: 'Reviewed pulse after quiet passage', reviewedPulseGrid: { bpm: 140, firstPulseSeconds: 0.11, provenance: 'manual', reviewed: true }, exits: [{ fileSeconds: 8.90, endSeconds: 9.22, kind: 'post_break_exit', provenance: 'manual', reviewed: true, label: 'Exit after quiet passage' }] },
};
