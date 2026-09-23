import { expect, test } from '@playwright/test';

test('new bundled songs appear without a reviewed BPM or cue claim', async ({page}) => {
  await page.goto('/');
  await page.getByText('Advanced controls', {exact:false}).click();
  const deck = page.getByRole('region', {name:'Deck A', exact:true});
  const picker = deck.getByLabel('Track to load on deck A');
  await expect(picker.locator('option')).toHaveCount(4);
  await expect(picker.locator('option').filter({hasText:'EDM or something'})).toHaveCount(1);
  await expect(picker.locator('option').filter({hasText:'Im Running Away'})).toHaveCount(1);
  await expect(picker.locator('option').filter({hasText:'The Power Of The Beat'})).toHaveCount(1);
  await expect(picker.locator('option').filter({hasText:'Random Drop'})).toHaveCount(1);
  await picker.selectOption({label:'EDM or something'});
  await deck.getByRole('button', {name:'Load track'}).click();
  await expect(deck.getByText('Ready')).toBeVisible();
  await deck.getByRole('button', {name:'Play'}).click();
  await expect(deck.getByText('On air')).toBeVisible();
  await expect(page.locator('.stage-bpm')).toHaveCount(0);
  await page.getByRole('button', {name:'Stop all'}).click();
});
