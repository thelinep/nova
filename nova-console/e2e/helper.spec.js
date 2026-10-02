const { test, expect } = require('@playwright/test');

test('helper: opens from the corner, runs a walkthrough, and can be hidden and shown again', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => setPrefs({ helperSpeak: false, helperEnabled: true }));
  await page.reload();
  await expect(page.locator('#hfFace')).toBeVisible();
  await page.locator('#hfFace').click();
  await expect(page.locator('#hfPanel')).toBeVisible();
  await expect(page.locator('#hfOpts')).toBeHidden();
  await page.locator('.hf-chip', { hasText: 'Let NOVA read a folder in chat' }).click();
  await expect(page.locator('.hf-tip')).toContainText('Add folder');
  await expect(page.locator('.hf-spot')).toHaveCount(1);
  await page.locator('.hf-tip [data-n="next"]').click();
  await expect(page.locator('.hf-tip')).toContainText('2 of 2');
  await page.locator('.hf-tip [data-n="next"]').click();
  await expect(page.locator('.hf-tip')).toHaveCount(0);
  await page.locator('#hfFace').click();
  await page.locator('#hfOptsBtn').click();
  await page.locator('#hfHide').click();
  await expect(page.locator('#novaHelper')).toBeHidden();
  await page.locator('.nav-item[data-view="settings"]').click();
  await page.locator('#setHelperOn').evaluate(el => { el.checked = true; el.dispatchEvent(new Event('change')); });
  await expect(page.locator('#hfFace')).toBeVisible();
});
