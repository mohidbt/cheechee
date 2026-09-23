import { expect, test } from '@playwright/test';

test('prepared transitions keep measured master output active in both directions', async ({page}) => {
  await page.goto('/');
  const measurements = await page.evaluate(async () => {
    const modulePath = '/src/audio/engine.ts';
    const {createAudioEngine} = await import(/* @vite-ignore */ modulePath) as typeof import('../../src/audio/engine');
    const tracks = [
      {id:'melodic', title:'Melodic', artist:'Fixture', tags:[], energy:'unknown' as const, source:'bundled' as const, loop:true, url:'/audio/melodicedm.wav'},
      {id:'loopy', title:'Loopy', artist:'Fixture', tags:[], energy:'unknown' as const, source:'bundled' as const, loop:true, url:'/audio/melodicloopyedm.wav'},
    ];
    const engine = createAudioEngine(tracks);
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const events: Array<{type:string; audioTime:number; observed:number}> = [];
    engine.subscribeLifecycle(event => events.push({type:event.type, audioTime:event.audioTime, observed:engine.getAudioTime()}));
    try {
      await engine.unlock();
      await engine.prepareTrack('melodic');
      await engine.prepareTrack('loopy');
      const first = await engine.commitStart('melodic');
      if (!first.ok) throw new Error(first.message);
      await wait(250);
      const measurements = [];
      for (const style of ['crossfade','filter','echo'] as const) {
        for (const target of ['loopy','melodic'] as const) {
          const before = engine.getState();
          const baseline = [];
          for (let sample = 0; sample < 6; sample++) { baseline.push(engine.getLevel()); await wait(20); }
          const desired = engine.getAudioTime() + 0.14;
          const committed = engine.commitTransition({type:'transition', track_id:target, style, duration_seconds:1.5}, desired);
          if (!committed.ok) throw new Error(`${style} to ${target}: ${committed.message}`);
          const samples: Array<{time:number; level:number; progress:number}> = [];
          const timer = setInterval(() => {
            const state = engine.getState();
            samples.push({time:state.audioTime, level:engine.getLevel(), progress:state.transition?.progress ?? 1});
          }, 20);
          const completionDeadline = performance.now() + 5000;
          while (engine.getState().transition && performance.now() < completionDeadline) await wait(50);
          await wait(100);
          clearInterval(timer);
          const after = engine.getState();
          const fade = samples.filter(sample => sample.time >= desired && sample.time <= desired + 1.5);
          const prestart = samples.filter(sample => sample.time < desired - 0.02);
          let longestLow = 0, low = 0;
          for (const sample of fade) {
            low = sample.level < 0.005 ? low + 1 : 0;
            longestLow = Math.max(longestLow, low);
          }
          measurements.push({style, from:before.decks.A.status === 'playing' ? 'A' : 'B', to:target,
            count:fade.length, minLevel:Math.min(...fade.map(sample => sample.level)),
            meanLevel:fade.reduce((sum, sample) => sum + sample.level, 0) / fade.length,
            baselineLevel:baseline.reduce((sum, level) => sum + level, 0) / baseline.length,
            prestartLevel:prestart.reduce((sum, sample) => sum + sample.level, 0) / prestart.length,
            longestLowMs:longestLow * 20, completed:after.transition === null,
            targetPlaying:Object.values(after.decks).some(deck => deck.status === 'playing' && deck.trackId === target),
            startDelayMs: Math.round(((events.filter(event => event.type === 'transition_started').at(-1)?.observed ?? desired) - desired) * 1000),
          });
        }
      }
      return measurements;
    } finally { engine.dispose(); }
  });
  for (const item of measurements) {
    expect(item.completed, JSON.stringify(item)).toBe(true);
    expect(item.targetPlaying, JSON.stringify(item)).toBe(true);
    expect(item.count, JSON.stringify(item)).toBeGreaterThan(30);
    expect(item.longestLowMs, JSON.stringify(item)).toBeLessThan(180);
    expect(item.startDelayMs, JSON.stringify(item)).toBeLessThan(130);
    if (item.style === 'filter') expect(item.prestartLevel / item.baselineLevel, JSON.stringify(item)).toBeGreaterThan(0.55);
  }
  console.log('Measured transitions:', JSON.stringify(measurements));
});
