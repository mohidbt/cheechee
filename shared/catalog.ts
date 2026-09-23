import type { AudioTrack, TrackCueSet } from './contracts';
export const demoTracks: AudioTrack[] = [
  {id:'edm-or-something',title:'EDM or something',artist:'Play House',tags:[],energy:'unknown',source:'bundled',loop:false,url:'/audio/play-house-edm-or-something.mp3'},
  {id:'im-running-away',title:'Im Running Away',artist:'Play House',tags:[],energy:'unknown',source:'bundled',loop:false,url:'/audio/play-house-im-running-away.mp3'},
  {id:'the-power-of-the-beat',title:'The Power Of The Beat',artist:'Play House',tags:[],energy:'unknown',source:'bundled',loop:false,url:'/audio/play-house-the-power-of-the-beat.mp3'},
  {id:'random-drop',title:'Random Drop',artist:'Play House',tags:[],energy:'unknown',source:'bundled',loop:false,url:'/audio/play-house-random-drop.mp3'},
];

// No reviewed pulse grids or cue points have been established for these songs.
export const demoCueSets: Record<string, TrackCueSet> = {};
