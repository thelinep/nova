const { test, expect } = require('@playwright/test');

test.describe('Help Center', () => {
  test('opens from the rail, searches, deep-links to a guide and shows the support checks', async ({ page }) => {
    await page.goto('/');
    await page.locator('.nav-item[data-view="help"]').click();
    await expect(page.locator('#helpView .view-title')).toHaveText('Help & Support');
    await expect(page.locator('.help-card').first()).toBeVisible();

    await page.locator('#helpSearch').fill('ollama unavailable');
    await expect(page.locator('.help-result').first()).toBeVisible();
    await page.locator('.help-result').first().click();
    await expect(page.locator('#helpSearch')).toHaveValue('');

    await page.goto('/#help/workflows/limits');
    await expect(page.locator('.help-title')).toHaveText('Workflows');
    await expect(page.locator('#limits')).toBeVisible();

    await page.locator('.help-tab[data-tab="faq"]').click();
    await expect(page.locator('.help-qa').first()).toBeVisible();

    await page.locator('.help-tab[data-tab="support"]').click();
    await expect(page.locator('.help-check').first()).toContainText('Maataa Workstation backend');
    await expect(page.locator('#helpCopyReport')).toBeEnabled();
  });

  test('the ? panel links to the full guide for that screen', async ({ page }) => {
    await page.goto('/');
    await page.locator('.nav-item[data-view="agents"]').click();
    await page.locator('#agentsView .help-btn').first().click();
    const more = page.locator('#helpDrawer .help-drawer-more a').first();
    await expect(more).toContainText('Read the full guide');
    await more.click();
    await expect(page.locator('.help-title')).toHaveText('Agents');
    await expect(page.locator('#helpDrawer')).toHaveCount(0);
  });

  test('help fits a phone-width window', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#help/settings-privacy');
    await expect(page.locator('.help-title')).toHaveText('Settings, privacy and your data');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
