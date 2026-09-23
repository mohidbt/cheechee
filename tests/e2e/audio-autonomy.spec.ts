import { expect, test } from '@playwright/test';

test('audio engine reconciles playback and cancels scheduled sources and echo tails', async ({page}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/audio/engine.ts';
    const {createAudioEngine} = await import(/* @vite-ignore */ modulePath) as typeof import('../../src/audio/engine');
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const tracks = [
      {id:'loop', title:'Loop', artist:'Fixture', tags:[], energy:'unknown' as const, source:'bundled' as const, loop:true, url:'/audio/melodicedm.wav'},
      {id:'next', title:'Next', artist:'Fixture', tags:[], energy:'unknown' as const, source:'bundled' as const, loop:true, url:'/audio/melodicloopyedm.wav'},
    ];
    const engine = createAudioEngine(tracks);
    const events: Array<{type:string; playbackId?:string; reason?:string}> = [];
    let stopOnTransitionStart = false;
    engine.subscribeLifecycle(event => {
      events.push(event);
      if (event.type === 'ended' && event.reason === 'transition') engine.getState();
      if (event.type === 'transition_started' && stopOnTransitionStart) {
        stopOnTransitionStart = false;
        engine.stopAll();
      }
    });
    try {
      await engine.unlock();
      const prepared = await engine.prepareTrack('loop');
      const started = await engine.commitStart('loop');
      const first = engine.getState().decks.A;
      await wait(7150);
      const looped = engine.getState().decks.A;
      const next = await engine.prepareTrack('next');
      const future = engine.commitTransition({type:'transition', track_id:'next', style:'crossfade', duration_seconds:1}, engine.getAudioTime() + 0.12);
      engine.stopAll();
      await wait(400);
      const afterScheduledStop = engine.getState();
      const targetStartedAfterStop = events.some(event => event.type === 'started' && event.playbackId !== first.playbackId);

      const restarted = await engine.prepareTrack('loop');
      const nextAgain = await engine.prepareTrack('next');
      const secondStart = await engine.commitStart('loop');
      const echo = engine.commitTransition({type:'transition', track_id:'next', style:'echo', duration_seconds:1}, engine.getAudioTime() + 0.05);
      await wait(1250);
      const completed = engine.getState();
      engine.stopAll();
      await wait(350);
      const afterEchoStop = engine.getState();
      const levelAfterEchoStop = engine.getLevel();

      await engine.prepareTrack('loop');
      await engine.prepareTrack('next');
      await engine.commitStart('loop');
      stopOnTransitionStart = true;
      const interrupted = engine.commitTransition({type:'transition', track_id:'next', style:'crossfade', duration_seconds:1}, engine.getAudioTime() + 0.04);
      await wait(250);
      const afterListenerStop = engine.getState();

      engine.setTracks([{...tracks[0], id:'short', loop:false}]);
      const shortPrepared = await engine.prepareTrack('short');
      const shortStarted = await engine.commitStart('short');
      const shortId = engine.getState().decks.A.playbackId;
      await wait(7100);
      const naturallyEnded = engine.getState().decks.A;
      return {
        prepared, started, next, future, restarted, nextAgain, secondStart, echo, shortPrepared, shortStarted,
        firstId:first.playbackId, loopedId:looped.playbackId, loopedPlayed:looped.playedSeconds,
        loopedPosition:looped.position, loopDuration:looped.duration,
        targetStartedAfterStop, afterScheduledStop, completed,
        afterEchoStop, levelAfterEchoStop, interrupted, afterListenerStop, shortId, naturallyEnded, events,
      };
    } finally {
      engine.dispose();
    }
  });

  for (const key of ['prepared','started','next','future','restarted','nextAgain','secondStart','echo','shortPrepared','shortStarted'] as const) {
    expect(result[key].ok, `${key}: ${result[key].message}`).toBe(true);
  }
  expect(result.firstId).toBeTruthy();
  expect(result.loopedId).toBe(result.firstId);
  expect(result.loopedPlayed).toBeGreaterThan(result.loopDuration);
  expect(result.loopedPosition).toBeLessThan(result.loopDuration);
  expect(result.targetStartedAfterStop).toBe(false);
  expect(result.afterScheduledStop.decks.A.status).not.toBe('playing');
  expect(result.afterScheduledStop.decks.B.status).not.toBe('playing');
  expect(result.completed.transition).toBeNull();
  expect(result.events.filter(event => event.type === 'transition_completed')).toHaveLength(1);
  expect(result.afterEchoStop.decks.A.status).not.toBe('playing');
  expect(result.afterEchoStop.decks.B.status).not.toBe('playing');
  expect(result.levelAfterEchoStop).toBeLessThan(0.02);
  expect(result.interrupted.ok).toBe(true);
  expect(result.afterListenerStop.transition).toBeNull();
  expect(result.afterListenerStop.decks.A.status).not.toBe('playing');
  expect(result.afterListenerStop.decks.B.status).not.toBe('playing');
  expect(result.shortId).toBeTruthy();
  expect(result.naturallyEnded.status).toBe('stopped');
  expect(result.naturallyEnded.playbackId).toBeNull();
  expect(result.events.some(event => event.type === 'ended' && event.playbackId === result.shortId && event.reason === 'natural')).toBe(true);
});
