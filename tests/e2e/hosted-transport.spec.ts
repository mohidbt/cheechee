import { expect, test, type Page, type Route } from '@playwright/test';
import { build, preview, type PreviewServer } from 'vite';
import type { AddressInfo } from 'node:net';

let server: PreviewServer;
let origin: string;

const status = { agent: true, speech: false, tts: false, model: 'hosted-fixture' };

async function openHosted(page: Page) {
  await page.route('**/api/status', route => route.fulfill({ json: status }));
  await page.goto(origin);
  await expect(page.getByText('Agent online', { exact: false })).toBeVisible();
}

test.beforeAll(async () => {
  await build({ logLevel: 'silent' });
  server = await preview({ preview: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'silent' });
  const address = server.httpServer.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
});

test('hosted HTTP manual tool changes real audio and performance video', async ({ page }) => {
  let request: any;
  await page.route('**/api/agent', async route => {
    request = route.request().postDataJSON();
    await route.fulfill({ json: { type: 'tool_call', requestId: request.requestId, batchId: 'hosted-manual', commands: [
      { type: 'load_track', deck: 'A', track_id: 'melodic' },
      { type: 'play', deck: 'A' },
    ] } });
  });
  await openHosted(page);
  await page.getByRole('textbox', { name: 'DJ command' }).fill('Play Melodic');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => request?.type).toBe('request');
  await expect(page.getByRole('region', { name: 'Performance mixer' }).getByText('Melodic')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Performance mixer' }).getByText('On air')).toBeVisible();
  await expect(page.getByLabel('DJ performance video')).toHaveAttribute('data-active-clip', 'start_a', { timeout: 12_000 });
  await page.getByRole('button', { name: "cheechee's thoughts" }).click();
  await expect(page.getByRole('complementary', { name: "cheechee's thoughts" }).locator('.activity-tool')).toHaveCount(2);
  await page.getByRole('button', { name: 'Stop all' }).click();
});

test('hosted HTTP autonomous decision starts playback through local acceptance', async ({ page }) => {
  let request: any;
  await page.route('**/api/agent', async route => {
    request = route.request().postDataJSON();
    await route.fulfill({ json: {
      type: 'dj_decision', requestId: request.requestId, decisionId: 'hosted-start',
      sessionId: request.sessionId, controlRevision: request.controlRevision,
      sourcePlaybackId: request.sourcePlaybackId,
      decision: { type: 'start', track_id: 'melodic', explanation: 'Starting a steady local set.' },
    } });
  });
  await openHosted(page);
  await page.getByRole('switch', { name: 'Autopilot' }).click();
  await expect.poll(() => request?.type).toBe('autonomy_request');
  await expect(page.getByRole('region', { name: 'Performance mixer' }).getByText('Melodic')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('region', { name: 'Performance mixer' }).getByText('On air')).toBeVisible();
  await page.getByRole('button', { name: "cheechee's thoughts" }).click();
  await expect(page.getByRole('complementary', { name: "cheechee's thoughts" }).getByText('Agent explanation: Starting a steady local set.')).toBeVisible();
  await expect(page.getByLabel('DJ performance video')).toHaveAttribute('data-active-clip', 'start_a', { timeout: 12_000 });
  await page.getByRole('button', { name: 'Stop all' }).click();
});

test('hosted HTTP cancellation ignores a late autonomous response', async ({ page }) => {
  let pending: Route | undefined;
  let release: (() => void) | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/agent', async route => {
    pending = route;
    await held;
    const request = route.request().postDataJSON();
    try {
      await route.fulfill({ json: {
        type: 'dj_decision', requestId: request.requestId, decisionId: 'too-late',
        sessionId: request.sessionId, controlRevision: request.controlRevision,
        sourcePlaybackId: request.sourcePlaybackId,
        decision: { type: 'start', track_id: 'melodic', explanation: 'This should be ignored.' },
      } });
    } catch { /* The browser may have already aborted the request. */ }
  });
  await openHosted(page);
  await page.getByRole('switch', { name: 'Autopilot' }).click();
  await expect.poll(() => !!pending).toBe(true);
  await page.getByRole('button', { name: 'Stop all' }).click();
  release?.();
  await page.waitForTimeout(400);
  await expect(page.getByRole('region', { name: 'Performance mixer' }).getByText('On air')).toHaveCount(0);
  await expect(page.getByLabel('DJ performance video')).toHaveAttribute('data-active-clip', 'idle');
  await expect(page.getByRole('switch', { name: 'Autopilot' })).toHaveAttribute('aria-checked', 'false');
});
