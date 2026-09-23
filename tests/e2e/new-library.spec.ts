import { expect, test } from '@playwright/test';

test('bundled Play House songs decode, play, and transition without old cue metadata', async ({page}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const catalogPath = '/shared/catalog.ts';
    const enginePath = '/src/audio/engine.ts';
    const {demoTracks, demoCueSets} = await import(/* @vite-ignore */ catalogPath) as typeof import('../../shared/catalog');
    const {createAudioEngine} = await import(/* @vite-ignore */ enginePath) as typeof import('../../src/audio/engine');
    const engine = createAudioEngine(demoTracks);
    try {
      await engine.unlock();
      const preparedA = await engine.prepareTrack(demoTracks[0].id);
      const preparedB = await engine.prepareTrack(demoTracks[1].id);
      const start = await engine.commitStart(demoTracks[0].id);
      const playing = engine.getState().decks.A;
      const transition = engine.commitTransition({type:'transition',track_id:demoTracks[1].id,style:'crossfade',duration_seconds:1});
      for (let i=0; i<35 && engine.getState().transition; i++) await new Promise(resolve => setTimeout(resolve, 50));
      const finished = engine.getState();
      return {tracks:demoTracks.map(track => ({id:track.id,url:track.url,loop:track.loop})), cueKeys:Object.keys(demoCueSets), preparedA, preparedB, start, playing, transition, finished};
    } finally { engine.dispose(); }
  });
  expect(result.tracks).toHaveLength(4);
  expect(result.tracks.every(track => track.url.endsWith('.mp3') && !track.loop)).toBe(true);
  expect(result.cueKeys).toEqual([]);
  expect(result.preparedA.ok).toBe(true);
  expect(result.preparedB.ok).toBe(true);
  expect(result.start.ok).toBe(true);
  expect(result.playing.status).toBe('playing');
  expect(result.playing.duration).toBeGreaterThan(160);
  expect(result.transition.ok).toBe(true);
  expect(result.finished.transition).toBeNull();
  expect(result.finished.decks.B.trackId).toBe('im-running-away');
  expect(result.finished.decks.B.status).toBe('playing');
});
