import { test, expect } from '@playwright/test';

test('video fills first screen and controls remain available', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const stage = page.getByRole('region', { name: 'DJ performance' });
  await expect(stage).toBeVisible();
  const bounds = await stage.boundingBox();
  expect(bounds?.height).toBe(900);
  await expect(page.getByRole('button', { name: 'Stop all' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Controls' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Track library' })).not.toBeInViewport();
  await page.screenshot({ path: 'test-results/immersive-desktop.png' });

  await page.getByRole('button', { name: 'Controls' }).click();
  await expect(page.getByRole('region', { name: 'DJ assistant' })).toBeInViewport();
  await expect(page.getByLabel('Performance deck A low EQ')).toBeVisible();
  await page.getByLabel('Performance deck A low EQ').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByLabel('Performance deck A low EQ')).toHaveValue('-1');
  await page.screenshot({ path: 'test-results/immersive-desktop-controls.png' });
  await page.getByRole('button', { name: 'Controls' }).click();
  await page.getByText('Advanced controls', { exact: false }).click();
  await expect(page.getByRole('region', { name: 'Deck A', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Track library' })).toBeVisible();
  await page.screenshot({ path: 'test-results/immersive-below-fold.png', fullPage: true });
});

test('mobile stage and touch controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const stage = page.getByRole('region', { name: 'DJ performance' });
  expect((await stage.boundingBox())?.height).toBe(844);
  await page.screenshot({ path: 'test-results/immersive-mobile.png' });
  await page.getByRole('button', { name: 'Controls' }).click();
  await expect(page.getByRole('region', { name: 'DJ assistant' })).toBeVisible();
  await page.screenshot({ path: 'test-results/immersive-mobile-controls.png' });
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390);
});
