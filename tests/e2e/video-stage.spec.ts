import { expect, test } from '@playwright/test';

test('filmed DJ follows real audio execution and Stop all returns to idle', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const stage = page.getByLabel('DJ performance video');
  await expect(stage).toHaveAttribute('data-active-clip', 'idle_hype');
  const idle = stage.locator('video.video-stage-idle');
  await expect(idle).toHaveJSProperty('muted', true);
  await expect(idle).toHaveJSProperty('playsInline', true);
  await expect.poll(() => idle.evaluate(video => (video as HTMLVideoElement).currentTime)).toBeGreaterThan(0);

  await page.getByRole('button', {name:'Controls'}).click();
  await page.getByText('Advanced controls', {exact:false}).click();
  const deckA = page.getByRole('region', {name:'Deck A'});
  await deckA.getByLabel('Track to load on deck A').selectOption({label:'Melodic'});
  await deckA.getByRole('button', {name:'Load track'}).click();
  await expect(stage).toHaveAttribute('data-active-clip', 'load_a', {timeout:10_000});
  await deckA.getByRole('button', {name:'Play'}).click();
  await expect(stage).toHaveAttribute('data-active-clip', 'start_a', {timeout:10_000});
  await page.getByLabel('Performance deck A low EQ').fill('-8');
  await page.getByLabel('Performance deck A low EQ').blur();
  await expect(stage).toHaveAttribute('data-active-clip', 'eq_low', {timeout:10_000});

  await page.getByLabel('Next track').selectOption({label:'Loopy · Fupi'});
  await page.getByLabel('Transition duration').selectOption('2');
  await page.route('**/video/crossfade_to_b.mp4', async route => {
    await new Promise(resolve => setTimeout(resolve, 700));
    await route.continue();
  });
  await page.getByRole('button', {name:'Start transition'}).click();
  await expect(stage).toHaveAttribute('data-pending-clip', 'crossfade_to_b');
  await stage.locator('.video-stage-action.is-visible').evaluate(video => video.dispatchEvent(new Event('ended')));
  await expect(stage).toHaveAttribute('data-pending-clip', 'crossfade_to_b');
  await expect(stage).toHaveAttribute('data-active-clip', 'crossfade_to_b', {timeout:10_000});
  await expect(page.getByRole('region', {name:'Deck B', exact:true}).getByText('On air')).toBeVisible();
  await page.getByRole('button', {name:'Stop all'}).click();
  await expect(stage).toHaveAttribute('data-active-clip', 'idle_hype');
  await page.waitForTimeout(400);
  await expect(stage).toHaveAttribute('data-active-clip', 'idle_hype');
  expect(errors).toEqual([]);
});
