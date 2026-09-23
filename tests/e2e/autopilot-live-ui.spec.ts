import { test, expect } from '@playwright/test';

test.use({ launchOptions: { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=LocalNetworkAccessChecks'] } });

test('live Nebius decision plays and completes a transition in the UI', async ({ page }) => {
  test.skip(process.env.LIVE_AUTOPILOT !== '1', 'Requires configured live providers and local Chrome.');
  test.setTimeout(110_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('Agent online', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Controls' }).click();
  await page.getByRole('switch', { name: 'Autopilot' }).click();
  const now = page.getByRole('region', { name: 'Performance mixer' });
  await expect(now.getByText('On air')).toBeVisible({ timeout: 20_000 });
  const first = await now.locator('.now-deck').filter({ hasText: 'On air' }).locator('.now-track strong').textContent();
  await expect(page.getByRole('complementary', { name: 'Actions' }).getByText('Transition completed.', { exact: true })).toBeVisible({ timeout: 85_000 });
  await expect(now.getByText('On air')).toBeVisible();
  const next = await now.locator('.now-deck').filter({ hasText: 'On air' }).locator('.now-track strong').textContent();
  expect(next).not.toBe(first);
  await page.screenshot({ path: 'test-results/autopilot-live-ui.png', fullPage: true });
  await page.getByRole('button', { name: 'Stop all' }).click();
  expect(errors).toEqual([]);
});
