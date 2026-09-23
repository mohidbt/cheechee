import { expect, test, type Page } from '@playwright/test';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import type { AddressInfo } from 'node:net';

const outDir = join(tmpdir(), `cheechee-voice-${process.pid}`);
const wav = readFileSync(new URL('../fixtures/audio/loop-a.wav', import.meta.url));
let server: PreviewServer;
let origin: string;

test.beforeAll(async () => {
  await build({ build: { outDir }, logLevel: 'silent' });
  server = await preview({ build: { outDir }, preview: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'silent' });
  origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
  rmSync(outDir, { recursive: true, force: true });
});

async function openHosted(page: Page, response: (request: any) => unknown, tts: string[]) {
  await page.route('**/api/status', route => route.fulfill({ json: { agent: true, speech: true, tts: true, model: 'fixture' } }));
  await page.route('**/api/agent', route => route.fulfill({ json: response(route.request().postDataJSON()) }));
  await page.route('**/api/tts', route => {
    tts.push(route.request().postDataJSON().text);
    return route.fulfill({ contentType: 'audio/wav', body: wav });
  });
  await page.goto(origin);
  await expect(page.getByRole('textbox', { name: 'DJ command' })).toBeEnabled();
}

async function ask(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'DJ command' }).fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}

test('speaks one plain conversational reply', async ({ page }) => {
  const tts: string[] = [];
  const reply = 'Doing well. Both decks are empty. What should I play?';
  await openHosted(page, request => ({ type: 'assistant_message', requestId: request.requestId, text: reply }), tts);
  await ask(page, 'How are you doing?');
  await expect.poll(() => tts).toEqual([reply]);
});

test('keeps tool results silent', async ({ page }) => {
  const tts: string[] = [];
  await openHosted(page, request => ({ type: 'tool_call', requestId: request.requestId, batchId: 'state-check', commands: [{ type: 'get_dj_state' }] }), tts);
  await ask(page, 'Check the decks');
  await expect(page.getByRole('button', { name: "cheechee's thoughts" })).toBeVisible();
  await page.getByRole('button', { name: "cheechee's thoughts" }).click();
  await expect(page.getByRole('complementary', { name: "cheechee's thoughts" }).locator('.activity-tool')).toHaveCount(1);
  expect(tts).toEqual([]);
});

test('voice reply toggle silences conversational replies', async ({ page }) => {
  const tts: string[] = [];
  await openHosted(page, request => ({ type: 'assistant_message', requestId: request.requestId, text: 'All good here.' }), tts);
  await page.getByRole('button', { name: 'Voice reply on' }).click();
  await ask(page, 'How is it going?');
  await page.getByRole('button', { name: "cheechee's thoughts" }).click();
  await expect(page.getByText('All good here.')).toBeVisible();
  expect(tts).toEqual([]);
});

test('keeps autonomous decisions silent', async ({ page }) => {
  const tts: string[] = [];
  await openHosted(page, request => ({
    type: 'dj_decision', requestId: request.requestId, decisionId: 'voice-autonomy',
    sessionId: request.sessionId, controlRevision: request.controlRevision,
    sourcePlaybackId: request.sourcePlaybackId,
    decision: { type: 'start', track_id: 'edm-or-something', explanation: 'Starting the set.' },
  }), tts);
  await page.getByRole('switch', { name: 'Autopilot' }).click();
  await expect(page.getByRole('region', { name: 'Performance mixer' }).getByText('On air')).toBeVisible({ timeout: 15_000 });
  expect(tts).toEqual([]);
  await page.getByRole('button', { name: 'Stop all' }).click();
});
