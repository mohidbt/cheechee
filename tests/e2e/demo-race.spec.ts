import { expect, test } from '@playwright/test';

test('a pending manual request cannot start Autopilot and a transition changes the playing song', async ({ page }) => {
  await page.route('**/api/status', route => route.fulfill({ json: { agent: true, speech: false, tts: false, model: 'fixture' } }));
  let sendTransition: (() => void) | undefined;
  let toolResult: any;
  let autonomyRequests = 0;
  await page.routeWebSocket('**/ws', socket => socket.onMessage(raw => {
    const message = JSON.parse(String(raw));
    if (message.type === 'request') sendTransition = () => socket.send(JSON.stringify({ type: 'tool_call', requestId: message.requestId, batchId: 'manual-switch', commands: [
      { type: 'transition', track_id: 'loopy', style: 'crossfade', duration_seconds: 1 },
    ] }));
    if (message.type === 'tool_result') { toolResult = message; socket.send(JSON.stringify({ type: 'agent_status', requestId: message.requestId, status: 'idle' })); }
    if (message.type === 'autonomy_request') autonomyRequests++;
  }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Enable audio' }).click();
  await page.getByText('Advanced controls', { exact: false }).click();
  const deck = page.getByRole('region', { name: 'Deck A' });
  await deck.getByLabel('Track to load on deck A').selectOption({ label: 'Melodic' });
  await deck.getByRole('button', { name: 'Load track' }).click();
  await expect(deck.getByText('Ready')).toBeVisible();
  await deck.getByRole('button', { name: 'Play' }).click();
  await expect(deck.getByText('On air')).toBeVisible();
  await page.getByRole('textbox', { name: 'DJ command' }).fill('Play Loopy next');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => !!sendTransition).toBe(true);
  await expect(page.getByRole('switch', { name: 'Autopilot' })).toBeDisabled();
  expect(autonomyRequests).toBe(0);
  sendTransition!();
  await expect.poll(() => toolResult?.result?.results?.[0]?.ok).toBe(true);
  await expect(page.getByRole('switch', { name: 'Autopilot' })).toBeEnabled();
  await expect(page.getByRole('complementary', { name: 'Actions' }).getByText('crossfade transition completed.')).toBeVisible({ timeout: 8000 });
  await page.getByRole('switch', { name: 'Autopilot' }).click();
  await expect.poll(() => autonomyRequests).toBe(1);
  await expect(page.getByRole('complementary', { name: 'Actions' }).getByText(/Agent unavailable/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Stop all audio' }).click();
});
