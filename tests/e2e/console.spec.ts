import { test, expect, type Page } from '@playwright/test';

const deck = (page: Page, id: 'A' | 'B') => page.getByRole('region', { name: `Deck ${id}` });

async function loadAndPlay(page: Page, id: 'A' | 'B', title: string) {
  const section = deck(page, id);
  await section.getByLabel(`Track to load on deck ${id}`).selectOption({ label: title });
  await section.getByRole('button', { name: 'Load track' }).click();
  await expect(section.getByText(title, { exact: true }).first()).toBeVisible();
  await expect(section.getByText('Ready')).toBeVisible();
  await section.getByRole('button', { name: 'Play' }).click();
  await expect(section.getByText('On air')).toBeVisible();
}

test('manual mixing surface plays, processes, transitions, and stops audio', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('Agent commands need', { exact: false }).or(page.getByText('NEBIUS_API_KEY', { exact: false })).or(page.getByText('Agent server disconnected', { exact: false }))).toBeVisible();
  await page.getByRole('button', { name: 'Enable audio' }).click();
  await expect(page.getByText('Sound is off')).toBeHidden();
  await loadAndPlay(page, 'A', 'Melodic');
  await expect.poll(async () => Number(await deck(page, 'A').getByRole('progressbar').getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  const scope = deck(page, 'A').locator('canvas');
  await expect.poll(async () => scope.evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext('2d');
    if (!context) return 0;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let lit = 0;
    for (let index = 0; index < data.length; index += 4) if (data[index] > 145 && data[index + 1] > 75 && data[index + 2] < 160) lit++;
    return lit;
  })).toBeGreaterThan(10);
  const lowEQ = deck(page, 'A').getByLabel('Deck A low EQ');
  await lowEQ.fill('-12');
  await lowEQ.blur();
  await expect(deck(page, 'A').getByText('-12', { exact: true })).toBeVisible();
  await deck(page, 'A').getByRole('button', { name: 'High pass' }).click();
  await expect(deck(page, 'A').getByRole('button', { name: 'High pass' })).toHaveAttribute('aria-pressed', 'true');
  await deck(page, 'A').getByRole('button', { name: 'Off' }).click();
  await expect(deck(page, 'A').getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
  await deck(page, 'B').getByLabel('Deck B low EQ').fill('-24');
  await deck(page, 'B').getByLabel('Deck B low EQ').blur();
  await deck(page, 'B').getByRole('button', { name: 'High pass' }).click();
  await deck(page, 'B').getByLabel('Deck B volume').fill('0.1');
  await page.screenshot({ path: 'test-results/console-desktop.png', fullPage: true });

  for (const style of ['Crossfade', 'Filter sweep', 'Echo out']) {
    await page.getByRole('button', { name: style, exact: true }).click();
    const source = await deck(page, 'A').getByText('On air').isVisible() ? 'A' : 'B';
    const target = source === 'A' ? 'B' : 'A';
    await page.getByLabel('Next track').selectOption({ label: source === 'A' ? 'Loopy · Fupi' : 'Skippy · Fupi' });
    await page.getByLabel('Transition duration').selectOption('2');
    await page.getByRole('button', { name: 'Start transition' }).click();
    await expect(deck(page, target).getByText('On air')).toBeVisible();
    if (target === 'B' && style === 'Crossfade') {
      await expect(deck(page, 'B').getByLabel('Deck B low EQ')).toHaveValue('0');
      await expect(deck(page, 'B').getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
      await expect(deck(page, 'B').getByLabel('Deck B volume')).toHaveValue('0.8');
    }
    if (source === 'A') await expect.poll(async () => Number(await page.getByLabel('Crossfader').inputValue())).toBeGreaterThan(0.05);
    else await expect.poll(async () => Number(await page.getByLabel('Crossfader').inputValue())).toBeLessThan(0.95);
    await expect(deck(page, source).getByText('Stopped')).toBeVisible({ timeout: 8000 });
    await expect(page.getByText('Preset transition')).toBeVisible();
  }

  await page.getByRole('button', { name: 'Filter sweep', exact: true }).click();
  await page.getByLabel('Transition duration').selectOption('8');
  await page.getByRole('button', { name: 'Start transition' }).click();
  await expect(page.getByText('in progress')).toBeVisible();
  await page.getByRole('button', { name: 'Stop all audio' }).click();
  await expect(deck(page, 'A').getByText('Stopped')).toBeVisible();
  await expect(deck(page, 'B').getByText('Stopped')).toBeVisible();
  await expect(page.getByText('in progress')).toBeHidden();
  expect(errors).toEqual([]);
});

test('small screen remains usable and accepts a local track', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390);
  await page.screenshot({ path: 'test-results/console-mobile.png', fullPage: true });
  await page.locator('input[type=file]').setInputFiles('public/audio/melodicedm.wav');
  await expect(page.getByRole('region', { name: 'Track library' }).getByText('melodicedm', { exact: true })).toBeVisible();
});

test('agent tool call reaches the browser mixer and acknowledges its actual state', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/status', route => route.fulfill({ json: { agent: true, speech: false, tts: false, model: 'test-only' } }));
  let acknowledgement: any;
  let requestId = '';
  await page.routeWebSocket('**/ws', socket => {
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.type === 'request') {
        requestId = message.requestId;
        socket.send(JSON.stringify({
          type: 'tool_call', requestId, batchId: 'browser-smoke', commands: [
            { type: 'load_track', deck: 'A', track_id: 'melodic' },
            { type: 'play', deck: 'A' },
            { type: 'set_eq', deck: 'A', low_db: -8, mid_db: 0, high_db: 0 },
            { type: 'set_filter', deck: 'A', mode: 'highpass', frequency_hz: 900, duration_seconds: 0.2 },
          ],
        }));
      }
      if (message.type === 'tool_result') {
        acknowledgement = message;
        socket.send(JSON.stringify({ type: 'assistant_message', requestId, text: message.result.message }));
        socket.send(JSON.stringify({ type: 'agent_status', requestId, status: 'idle' }));
      }
    });
  });

  await page.goto('/');
  await expect(page.getByText('Agent online', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Enable audio' }).click();
  await page.getByRole('textbox', { name: 'DJ command' }).fill('Play Melodic with less bass');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => acknowledgement?.result?.results?.length).toBe(4);
  expect(acknowledgement).toMatchObject({
    type: 'tool_result', requestId, batchId: 'browser-smoke',
    result: {
      ok: true,
      state: { decks: { A: { trackId: 'melodic', status: 'playing', eq: { low: -8 }, filter: { mode: 'highpass', frequency: 900 } } } },
    },
  });
  expect(acknowledgement.result.results.every((result: { ok: boolean }) => result.ok)).toBe(true);
  await expect(deck(page, 'A').getByText('On air')).toBeVisible();
  await expect(deck(page, 'A').getByLabel('Deck A low EQ')).toHaveValue('-8');
  await expect(deck(page, 'A').getByRole('button', { name: 'High pass' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Playing Melodic on deck A.', { exact: false }).first()).toBeVisible();
  expect(errors).toEqual([]);
});
