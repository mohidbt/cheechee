import { expect, test } from '@playwright/test';

test.use({launchOptions:{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--autoplay-policy=no-user-gesture-required','--disable-features=LocalNetworkAccessChecks']}});

test('ten minute live Autopilot set through the browser audio engine', async ({page}) => {
  test.skip(process.env.RUN_AUTONOMY_SOAK !== '1', 'Set RUN_AUTONOMY_SOAK=1 for the long live-provider check.');
  test.setTimeout(11 * 60_000);
  page.on('console', message => { if (message.type() === 'error') console.log(`Chrome console: ${message.text()}`); });
  page.on('websocket', socket => socket.on('socketerror', error => console.log(`Chrome websocket: ${socket.url()} ${error}`)));
  await page.route('http://127.0.0.1:5173/', route => route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html><head><title>Autopilot soak</title></head><body></body></html>'}));
  await page.goto('/');
  const socketPreflight = await page.evaluate(() => Promise.all([5173,3001].map(port => new Promise<{origin:string;port:number;result:string}>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timer = setTimeout(() => {socket.close();resolve({origin:self.origin,port,result:'timeout'});},3000);
    socket.onopen = () => {clearTimeout(timer);socket.close();resolve({origin:self.origin,port,result:'open'});};
    socket.onclose = event => {clearTimeout(timer);resolve({origin:self.origin,port,result:`closed ${event.code}: ${event.reason}`});};
    socket.onerror = () => {clearTimeout(timer);resolve({origin:self.origin,port,result:'error'});};
  }))));
  expect(socketPreflight[0].result, `WebSocket preflight: ${JSON.stringify(socketPreflight)}`).toBe('open');
  await page.evaluate(async () => {
    const enginePath = '/src/audio/engine.ts';
    const bridgePath = '/src/bridge.ts';
    const controllerPath = '/src/autopilot/controller.ts';
    const cataloguePath = '/shared/catalog.ts';
    const {createAudioEngine} = await import(/* @vite-ignore */ enginePath) as typeof import('../../src/audio/engine');
    const {DJBridge} = await import(/* @vite-ignore */ bridgePath) as typeof import('../../src/bridge');
    const {AutopilotController} = await import(/* @vite-ignore */ controllerPath) as typeof import('../../src/autopilot/controller');
    const {demoTracks} = await import(/* @vite-ignore */ cataloguePath) as typeof import('../../shared/catalog');
    const engine = createAudioEngine(demoTracks);
    const stats = {starts:0, transitionsStarted:0, completions:0, naturalEnds:0, requests:0, acceptedDecisions:0, agentMovesScheduled:0, modelLatenciesMs:[] as number[], fallbacks:0, connected:false, connectionEvents:[] as boolean[], errors:[] as string[], maxLevel:0, audibleSamples:0, totalSamples:0, lastState:''};
    const bridge = new DJBridge(engine, () => demoTracks, event => {
      if (event.type === 'connection') { stats.connected = event.connected; stats.connectionEvents.push(event.connected); }
      if (event.type === 'autonomy_failure') stats.errors.push(event.reason);
      if (event.type === 'error') stats.errors.push(event.text);
    });
    const controller = new AutopilotController(engine, bridge, () => demoTracks, () => {}, trace => {
      if (trace.text.includes('deciding')) stats.requests++;
      if (trace.text.startsWith('Agent explanation:')) {
        stats.acceptedDecisions++;
        try { const latency = JSON.parse(trace.detail || '{}').modelLatencyMs; if (typeof latency === 'number') stats.modelLatenciesMs.push(latency); } catch { /* malformed trace detail is already visible in Actions */ }
      }
      if (trace.text.startsWith('Agent move scheduled:')) stats.agentMovesScheduled++;
      if (trace.text.startsWith('Automatic transition:') && trace.status === 'scheduled') stats.fallbacks++;
      if (trace.status === 'failed') stats.errors.push(trace.text);
    });
    engine.subscribeLifecycle(event => {
      if (event.type === 'started') stats.starts++;
      if (event.type === 'transition_started') stats.transitionsStarted++;
      if (event.type === 'transition_completed') stats.completions++;
      if (event.type === 'ended' && event.reason === 'natural') stats.naturalEnds++;
    });
    bridge.connect();
    await new Promise<void>((resolve,reject) => {
      const started = performance.now();
      const timer = setInterval(() => {
        if (stats.connected) { clearInterval(timer); resolve(); }
        else if (performance.now() - started > 5000) { clearInterval(timer); reject(new Error(`Agent socket did not connect: ${JSON.stringify({url:location.href,events:stats.connectionEvents,errors:stats.errors,socketState:(bridge as any).socket?.readyState})}`)); }
      }, 50);
    });
    await engine.unlock();
    if (!controller.enable()) throw new Error('Autopilot did not enable.');
    const sampler = setInterval(() => {
      const level = engine.getLevel();
      stats.maxLevel = Math.max(stats.maxLevel, level);
      stats.totalSamples++;
      if (level > 0.005) stats.audibleSamples++;
      stats.lastState = controller.getStatus().line;
    }, 500);
    (window as any).__autonomySoak = {engine,bridge,controller,stats,sampler};
  });
  try {
    for (let minute = 0; minute < 10; minute++) {
      await page.waitForTimeout(60_000);
      const stats = await page.evaluate(() => (window as any).__autonomySoak.stats);
      console.log(`Autopilot minute ${minute + 1}: ${JSON.stringify(stats)}`);
      if (minute === 0) expect(stats.starts, `First minute status: ${stats.lastState}`).toBeGreaterThan(0);
    }
    const stats = await page.evaluate(() => (window as any).__autonomySoak.stats);
    expect(stats.completions).toBeGreaterThanOrEqual(8);
    expect(stats.requests).toBeLessThanOrEqual(15);
    expect(stats.agentMovesScheduled).toBeGreaterThan(0);
    expect(stats.maxLevel).toBeGreaterThan(0.005);
    expect(stats.audibleSamples).toBeGreaterThan(0);
  } finally {
    await page.evaluate(() => {
      const soak = (window as any).__autonomySoak;
      if (!soak) return;
      clearInterval(soak.sampler);
      soak.controller.stopAll();
      soak.engine.stopAll();
      soak.bridge.close();
      soak.controller.dispose();
      soak.engine.dispose();
    });
  }
});
