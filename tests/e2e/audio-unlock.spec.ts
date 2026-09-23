import { chromium, expect, test } from '@playwright/test';

test('first Autopilot click unlocks audio under normal gesture policy', async () => {
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--autoplay-policy=user-gesture-required'],
  });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:5173/');
    const toggle = page.getByRole('switch', { name: 'Autopilot' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
