import { expect, test } from '@playwright/test';

test('Autopilot pace setting reschedules one browser controller window', async ({ page }) => {
  await page.route('**/api/status', route => route.fulfill({ json: { agent: true, speech: false, tts: false, model: 'fixture' } }));
  const requests: any[] = [];
  const cancelled: string[] = [];
  await page.routeWebSocket('**/ws', socket => socket.onMessage(raw => {
    const message = JSON.parse(String(raw));
    if (message.type === 'autonomy_request') {
      requests.push(message);
      if (message.trigger === 'cold_start') socket.send(JSON.stringify({ type: 'dj_decision', requestId: message.requestId, decisionId: 'start', sessionId: message.sessionId, controlRevision: message.controlRevision, sourcePlaybackId: message.sourcePlaybackId, decision: { type: 'start', track_id: 'melodic', explanation: 'Start the set.' } }));
    }
    if (message.type === 'cancel') cancelled.push(message.requestId);
  }));
  await page.goto('/');
  const pace = page.getByRole('combobox', { name: 'Time between changes' });
  await expect(pace).toHaveValue('20');
  await pace.selectOption('60');
  await page.getByRole('button', { name: 'Controls' }).click();
  await page.getByRole('switch', { name: 'Autopilot' }).click();
  await expect(page.getByRole('region', { name: 'Performance mixer' }).getByText('On air')).toBeVisible({ timeout: 15_000 });
  expect(requests).toHaveLength(1);
  expect(requests[0].context.requestedChangeIntervalSeconds).toBe(60);
  await pace.selectOption('120');
  await page.waitForTimeout(250);
  expect(requests).toHaveLength(1);
  await pace.selectOption('20');
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].trigger).toBe('planning');
  expect(requests[1].context.requestedChangeIntervalSeconds).toBe(20);
  expect(requests[1].desiredInSeconds).toBeGreaterThanOrEqual(14);
  expect(requests[1].desiredInSeconds).toBeLessThan(30);
  await page.waitForTimeout(500);
  expect(requests).toHaveLength(2);
  expect(await page.getByRole('region', { name: 'Performance mixer' }).getByText('On air').count()).toBe(1);
  await pace.selectOption('60');
  await expect.poll(() => cancelled).toContain(requests[1].requestId);
  await page.getByRole('button', { name: 'Stop all' }).click();
});
