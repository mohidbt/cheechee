import { expect, test } from '@playwright/test';

test('Library analysis and a manual next-cue request show scheduled then completed playback', async ({ page }) => {
  test.setTimeout(60_000);
  await page.route('**/api/status', route => route.fulfill({ json: { agent: true, speech: false, tts: false, model: 'fixture' } }));
  let acknowledgement: any;
  await page.routeWebSocket('**/ws', socket => {
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.type === 'request') socket.send(JSON.stringify({ type: 'tool_call', requestId: message.requestId, batchId: 'cue', commands: [
        { type: 'transition', track_id: 'loopy', style: 'crossfade', duration_seconds: 2, timing: 'next_cue' },
      ] }));
      if (message.type === 'tool_result') { acknowledgement = message; socket.send(JSON.stringify({ type: 'assistant_message', requestId: message.requestId, text: message.result.message })); socket.send(JSON.stringify({ type: 'agent_status', requestId: message.requestId, status: 'idle' })); }
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Enable audio' }).click();
  const library = page.getByRole('region', { name: 'Track library' });
  await library.getByRole('button', { name: 'Analyze tracks' }).click();
  await expect(library.getByText(/BPM estimated/).first()).toBeVisible({ timeout: 25_000 });
  await expect(library.getByRole('button', { name: 'Analyze tracks' })).toBeEnabled();
  await page.getByText('Advanced controls', { exact: false }).click();
  const deck = page.getByRole('region', { name: 'Deck A' });
  await deck.getByLabel('Track to load on deck A').selectOption({ label: 'Melodic' });
  await deck.getByRole('button', { name: 'Load track' }).click();
  await expect(deck.getByText('Ready')).toBeVisible();
  await deck.getByRole('button', { name: 'Play' }).click();
  await expect(deck.getByText('On air')).toBeVisible();
  await page.getByRole('textbox', { name: 'DJ command' }).fill('Move to Loopy at the next reviewed cue');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => acknowledgement?.result?.results?.[0]?.scheduled).toBe(true);
  expect(acknowledgement.result.results[0].ok).toBe(true);
  await expect(page.getByRole('complementary', { name: 'Actions' }).getByText(/Manual transition scheduled for next reviewed cue/)).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Actions' }).getByText('Transition completed.', { exact: true })).toBeVisible({ timeout: 15_000 });
  const actions = page.getByRole('complementary', { name: 'Actions' });
  const committed = JSON.parse((await actions.locator('.activity-item').filter({ hasText: 'Manual next cue committed' }).locator('pre').textContent())!.split('\n').slice(1).join('\n'));
  const started = JSON.parse((await actions.locator('.activity-item').filter({ hasText: 'Transition started.' }).locator('pre').textContent())!.split('\n').slice(1).join('\n'));
  expect(committed.cue.fileSeconds).toBeCloseTo(2.681, 2);
  expect(committed.cue.alignment).toBe('reviewed_pulse_grid');
  expect(Math.abs(started.audioTime - committed.targetAudioTime)).toBeLessThan(0.05);
  await expect(page.getByRole('region', { name: 'Now playing' }).getByText('Loopy')).toBeVisible();
  await page.getByRole('button', { name: 'Stop all audio' }).click();
});

test('Stop all cancels a scheduled manual cue before the next loop', async ({ page }) => {
  await page.route('**/api/status', route => route.fulfill({ json: { agent: true, speech: false, tts: false, model: 'fixture' } }));
  let acknowledgement: any;
  await page.routeWebSocket('**/ws', socket => socket.onMessage(raw => {
    const message = JSON.parse(String(raw));
    if (message.type === 'request') socket.send(JSON.stringify({ type: 'tool_call', requestId: message.requestId, batchId: 'cue-stop', commands: [
      { type: 'transition', track_id: 'loopy', style: 'crossfade', duration_seconds: 2, timing: 'next_cue' },
    ] }));
    if (message.type === 'tool_result') { acknowledgement = message; socket.send(JSON.stringify({ type: 'agent_status', requestId: message.requestId, status: 'idle' })); }
  }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Enable audio' }).click();
  await page.getByText('Advanced controls', { exact: false }).click();
  const deck = page.getByRole('region', { name: 'Deck A' });
  await deck.getByLabel('Track to load on deck A').selectOption({ label: 'Melodic' });
  await deck.getByRole('button', { name: 'Load track' }).click();
  await expect(deck.getByText('Ready')).toBeVisible();
  await deck.getByRole('button', { name: 'Play' }).click();
  await page.getByRole('textbox', { name: 'DJ command' }).fill('Move to Loopy at the next reviewed cue');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => acknowledgement?.result?.results?.[0]?.scheduled).toBe(true);
  await page.getByRole('button', { name: 'Stop all audio' }).click();
  await page.waitForTimeout(7500);
  expect(await page.getByRole('region', { name: 'Now playing' }).getByText('On air').count()).toBe(0);
});
