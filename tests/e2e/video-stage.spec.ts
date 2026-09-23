import { expect, test } from '@playwright/test';

test('filmed DJ follows real audio execution and Stop all returns to idle', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const stage = page.getByLabel('DJ performance video');
  await expect(stage).toHaveAttribute('data-active-clip', 'idle');
  const idle = stage.locator('video.video-stage-idle.is-active');
  await expect(idle).toHaveJSProperty('muted', true);
  await expect(idle).toHaveJSProperty('playsInline', true);
  await expect.poll(() => idle.evaluate(video => (video as HTMLVideoElement).currentTime)).toBeGreaterThan(0);

  await expect(page.locator('.advanced-controls')).toHaveAttribute('open', '');
  const deckA = page.getByRole('region', {name:'Deck A', exact:true});
  await deckA.getByLabel('Track to load on deck A').selectOption({label:'EDM or something'});
  await deckA.getByRole('button', {name:'Load track'}).click();
  await expect(stage).toHaveAttribute('data-active-clip', 'idle', {timeout:10_000});
  await expect(stage).not.toHaveAttribute('data-pending-clip', 'load_a');
  await deckA.getByRole('button', {name:'Play'}).click();
  await expect(stage).toHaveAttribute('data-active-clip', 'start_a', {timeout:10_000});
  await stage.locator('.video-stage-action.is-visible').evaluate(video => video.dispatchEvent(new Event('ended')));
  await expect(stage).toHaveAttribute('data-active-clip', 'idle_hype');
  await page.getByLabel('Performance deck A low EQ').fill('-8');
  await page.getByLabel('Performance deck A low EQ').blur();
  await expect(stage).toHaveAttribute('data-active-clip', 'eq_low', {timeout:10_000});

  await page.getByLabel('Next track').selectOption({label:'Im Running Away · Play House'});
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
  await expect(stage).toHaveAttribute('data-active-clip', 'idle');
  await page.waitForTimeout(400);
  await expect(stage).toHaveAttribute('data-active-clip', 'idle');
  expect(errors).toEqual([]);
});

test('transition action clips play in both directions over successive mixes', async ({page}) => {
  await page.goto('/');
  const stage = page.getByLabel('DJ performance video');
  await expect(page.locator('.advanced-controls')).toHaveAttribute('open', '');
  const deckA = page.getByRole('region', {name:'Deck A', exact:true});
  await deckA.getByLabel('Track to load on deck A').selectOption({label:'EDM or something'});
  await deckA.getByRole('button', {name:'Load track'}).click();
  await expect(deckA.getByText('Ready')).toBeVisible();
  await deckA.getByRole('button', {name:'Play'}).click();
  await expect(deckA.getByText('On air')).toBeVisible();
  await page.getByLabel('Transition duration').selectOption('2');
  for (const [song, clip, deck] of [
    ['Im Running Away · Play House', 'crossfade_to_b', 'B'],
    ['The Power Of The Beat · Play House', 'crossfade_to_a', 'A'],
    ['Random Drop · Play House', 'crossfade_to_b', 'B'],
  ] as const) {
    await page.getByLabel('Next track').selectOption({label:song});
    await page.getByRole('button', {name:'Start transition'}).click();
    await expect(stage).toHaveAttribute('data-active-clip', clip, {timeout:10_000});
    await expect(page.getByRole('region', {name:`Deck ${deck}`, exact:true}).getByText('On air')).toBeVisible();
    await expect(page.getByRole('button', {name:'Start transition'})).toBeEnabled({timeout:10_000});
  }
  await page.getByRole('button', {name:'Stop all'}).click();
});
