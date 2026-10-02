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
  await page.locator('#vsSave').click();
  await expect(page.locator('.vs-char', { hasText: 'Meera' })).toBeVisible();
  await expect(page.locator('#vsSpeaksAs option', { hasText: 'Meera' })).toHaveCount(1);
  await page.locator('#vsDelete').click();
  await page.locator('#vsDelete').click();
  await expect(page.locator('.vs-char', { hasText: 'Meera' })).toHaveCount(0);
});
