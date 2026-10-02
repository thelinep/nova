const { test, expect } = require('@playwright/test');

test('Voice Studio: make a character, see it listed, delete it', async ({ page }) => {
  await page.goto('/');
  await page.locator('.nav-item[data-view="voicestudio"]').click();
  await expect(page.locator('#voicestudioView .view-title')).toHaveText('Voice Studio');
  await page.locator('#vsNew').click();
  await page.locator('#vsName').fill('Meera');
  await page.locator('#vsTagline').fill('a calm first AD');
  await page.locator('#vsMixAdd').click();
  await expect(page.locator('.vs-mix-voice')).toHaveCount(2);
  await page.locator('#vsMood').selectOption('warm');
  await expect(page.locator('#vsAuto')).toBeChecked();
  await page.locator('#vsSay').fill('');
  await page.locator('.vs-cue[data-c="shout"]').click();
  await expect(page.locator('#vsSay')).toHaveValue('[shout] ');
  await expect(page.locator('#vsPreviewMood option[value="singing"]')).toHaveCount(1);
  await page.locator('#vsSave').click();
  await expect(page.locator('.vs-char', { hasText: 'Meera' })).toBeVisible();
  const saved = await page.evaluate(() => fetch('/api/characters').then(r => r.json()));
  expect(saved.find(c => c.name === 'Meera').delivery).toEqual({ mood: 'warm', auto: true });
  await expect(page.locator('#vsSpeaksAs option', { hasText: 'Meera' })).toHaveCount(1);
  await page.locator('#vsDelete').click();
  await page.locator('#vsDelete').click();
  await expect(page.locator('.vs-char', { hasText: 'Meera' })).toHaveCount(0);
});
