import { expect, test } from '@playwright/test';

test('local analysis and cue offsets use decoded media and the audio clock', async ({page}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/audio/engine.ts';
    const {createAudioEngine} = await import(/* @vite-ignore */ modulePath) as typeof import('../../src/audio/engine');
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const tracks = [
      {id:'a', title:'A', artist:'Fixture', tags:[], energy:'unknown' as const, source:'bundled' as const, loop:true, url:'/audio/melodicedm.wav'},
      {id:'b', title:'B', artist:'Fixture', tags:[], energy:'unknown' as const, source:'bundled' as const, loop:true, url:'/audio/melodicloopyedm.wav'},
    ];
    const engine = createAudioEngine(tracks);
    const events: Array<{type:string; deck?:string; audioTime:number}> = [];
    engine.subscribeLifecycle(event => events.push(event));
    try {
      await engine.unlock();
      const preparation = await engine.prepareTrack('a');
      let lastTimer = performance.now(), maxTimerGapMs = 0;
      const responsivenessTimer = setInterval(() => {
        const current = performance.now();
        maxTimerGapMs = Math.max(maxTimerGapMs, current - lastTimer);
        lastTimer = current;
      }, 16);
      const analysisStart = performance.now();
      const analysis = await engine.analyzeTrack('a');
      const analysisMs = performance.now() - analysisStart;
      clearInterval(responsivenessTimer);
      const secondAnalysis = await engine.analyzeTrack('b');
      const cached = engine.getTrackAnalysis('a');
      const secondPreparation = await engine.prepareTrack('b');
      const invalidStart = await engine.commitStart('a', analysis.durationSeconds.value);
      const started = await engine.commitStart('a', 2);
      const initial = engine.getState().decks.A;
      for (let tries = 0; tries < 120 && engine.getState().decks.A.playedSeconds < 5.2; tries++) await wait(100);
      const wrapped = engine.getState().decks.A;
      const invalidTransition = engine.commitTransition({type:'transition', track_id:'b', style:'crossfade', duration_seconds:1}, engine.getAudioTime() + 0.08, -1);
      const targetTime = engine.getAudioTime() + 0.08;
      const transition = engine.commitTransition({type:'transition', track_id:'b', style:'crossfade', duration_seconds:1}, targetTime, 1.25);
      const beforeTarget = engine.getState().decks.B;
      await wait(280);
      const incoming = engine.getState().decks.B;
      await wait(1000);
      const finished = engine.getState();
      return {preparation, analysis, secondAnalysis, analysisMs, maxTimerGapMs, cached, secondPreparation, invalidStart, started, initial, wrapped,
        invalidTransition, transition, beforeTarget, incoming, finished, events,
        targetTime, observedStart:events.find(event => event.type === 'started' && event.deck === 'B')?.audioTime};
    } finally { engine.dispose(); }
  });

  expect(result.preparation.ok).toBe(true);
  expect(result.secondPreparation.ok).toBe(true);
  expect(result.analysis.contentKey).toMatch(/^[0-9a-f]{64}$/);
  expect(result.analysis.analysisVersion).toBeGreaterThan(0);
  expect(result.analysis.durationSeconds).toMatchObject({provenance:'measured'});
  expect(result.analysis.rms.values.length).toBeGreaterThan(1);
  expect(result.analysis.rms.values.length).toBeLessThanOrEqual(256);
  expect(result.analysis.rms.values.some(value => value > 0.01)).toBe(true);
  expect(result.analysis.estimatedTempo === null || result.analysis.estimatedTempo.reviewed === false).toBe(true);
  expect(result.cached?.contentKey).toBe(result.analysis.contentKey);
  expect(result.invalidStart).toMatchObject({ok:false, code:'invalid_cue'});
  expect(result.started.ok).toBe(true);
  expect(result.initial.position).toBeGreaterThanOrEqual(2);
  expect(result.initial.playedSeconds).toBeLessThan(0.15);
  expect(result.wrapped.playbackId).toBe(result.initial.playbackId);
  expect(result.wrapped.playedSeconds).toBeGreaterThan(5);
  expect(result.wrapped.position).toBeLessThan(2);
  expect(result.invalidTransition).toMatchObject({ok:false, code:'invalid_cue'});
  expect(result.transition.ok).toBe(true);
  expect(result.beforeTarget.playedSeconds).toBe(0);
  expect(result.incoming.position).toBeGreaterThan(1.25);
  expect(result.incoming.position).toBeLessThan(1.6);
  expect(result.incoming.playedSeconds).toBeGreaterThan(0);
  expect(result.observedStart).toBeCloseTo(result.targetTime, 2);
  expect(result.finished.transition).toBeNull();
  expect(result.finished.decks.B.status).toBe('playing');
  console.log('Demo estimated tempo:', JSON.stringify(result.analysis.estimatedTempo));
  console.log('Loopy estimated tempo:', JSON.stringify(result.secondAnalysis.estimatedTempo));
  console.log('Explicit analysis timing:', Math.round(result.analysisMs), 'ms; max 16ms timer gap:', Math.round(result.maxTimerGapMs), 'ms');
});

test('versioned analysis is reused from IndexedDB after reload', async ({page}) => {
  await page.goto('/');
  const analyze = async (blockPcmReads: boolean) => page.evaluate(async blocked => {
    const modulePath = '/src/audio/engine.ts';
    const {createAudioEngine} = await import(/* @vite-ignore */ modulePath) as typeof import('../../src/audio/engine');
    const engine = createAudioEngine([{id:'cached', title:'Cached', artist:'Fixture', tags:[], energy:'unknown', source:'bundled', loop:true, url:'/audio/melodicskippyedm.wav'}]);
    await engine.unlock();
    await engine.prepareTrack('cached');
    const original = AudioBuffer.prototype.getChannelData;
    if (blocked) AudioBuffer.prototype.getChannelData = () => { throw new Error('PCM analysis should be skipped on cache hit.'); };
    try { return await engine.analyzeTrack('cached'); }
    finally { AudioBuffer.prototype.getChannelData = original; engine.dispose(); }
  }, blockPcmReads);
  const first = await analyze(false);
  console.log('Skippy estimated tempo:', JSON.stringify(first.estimatedTempo));
  await page.reload();
  const second = await analyze(true);
  expect(second.contentKey).toBe(first.contentKey);
  expect(second.analysisVersion).toBe(first.analysisVersion);
  expect(second.estimatedTempo).toEqual(first.estimatedTempo);
  expect(second.rms.values).toEqual(first.rms.values);
});

test('late cue commit leaves a short source playing', async ({page}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/audio/engine.ts';
    const {createAudioEngine} = await import(/* @vite-ignore */ modulePath) as typeof import('../../src/audio/engine');
    const engine = createAudioEngine([
      {id:'short', title:'Short', artist:'Fixture', tags:[], energy:'unknown', source:'bundled', loop:false, url:'/audio/melodicedm.wav'},
      {id:'next', title:'Next', artist:'Fixture', tags:[], energy:'unknown', source:'bundled', loop:true, url:'/audio/melodicloopyedm.wav'},
    ]);
    const events: string[] = [];
    engine.subscribeLifecycle(event => { if (event.type === 'ended') events.push(event.reason); });
    try {
      await engine.unlock();
      await engine.prepareTrack('short');
      await engine.prepareTrack('next');
      await engine.commitStart('short', 5.9);
      const before = engine.getState();
      const commit = engine.commitTransition({type:'transition', track_id:'next', style:'crossfade', duration_seconds:2}, engine.getAudioTime() + 0.05);
      const after = engine.getState();
      for (let tries = 0; tries < 40 && engine.getState().decks.A.status === 'playing'; tries++) await new Promise(resolve => setTimeout(resolve, 100));
      return {before, commit, after, ended:engine.getState().decks.A, events};
    } finally { engine.dispose(); }
  });
  expect(result.commit).toMatchObject({ok:false, code:'source_too_short'});
  expect(result.after.transition).toBeNull();
  expect(result.after.decks.A.playbackId).toBe(result.before.decks.A.playbackId);
  expect(result.ended.status).toBe('stopped');
  expect(result.ended.position).toBeCloseTo(result.ended.duration, 2);
  expect(result.ended.playedSeconds).toBeGreaterThan(0.8);
  expect(result.ended.playedSeconds).toBeLessThan(1.5);
  expect(result.events).toContain('natural');
});
