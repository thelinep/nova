const { test, expect } = require('@playwright/test');

test('Lipi OS: twelve-script welcome, converter, registry, newsroom transliteration', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.locator('.nav-item[data-view="lipios"]').click();
  await expect(page.locator('#lipiosView')).toHaveClass(/active/);
  await expect(page.locator('#lipiosView .lo-card')).toHaveCount(12);
  await expect(page.locator('#lipiosView .lo-card').first()).toContainText('𑀆𑀧𑁆𑀓𑀸 𑀲𑁆𑀯𑀸𑀕𑀢 𑀳𑁃');
  await page.locator('.lo-card[data-code="Shrd"]').click();
  await expect(page.locator('.lo-focus')).toContainText('𑆄𑆥𑇀𑆑𑆳');

  await page.locator('[data-lo-tab="convert"]').click();
  await page.locator('#loText').fill('धर्म');
  await page.locator('#loHindi').uncheck();
  await page.locator('#loGo').click();
  await expect(page.locator('#lipiosView .lo-res')).toContainText(['dharma']);
  await expect(page.locator('#lipiosView')).toContainText('𑀥𑀭𑁆𑀫');

  await page.locator('[data-lo-tab="scripts"]').click();
  await page.locator('tr[data-code="Inds"]').click();
  await expect(page.locator('#lipiosView')).toContainText('Exhibition only');

  await page.locator('[data-lo-tab="newsroom"]').click();
  await page.locator('#loNewEd').click();
  await page.locator('#loSrcH').fill('आपका स्वागत है');
  await page.locator('[data-tl="1"]').click();
  await expect(page.locator('[data-lane="1"] [name=headline]')).toHaveValue('𑀆𑀧𑀓𑀸 𑀲𑁆𑀯𑀸𑀕𑀢 𑀳𑁃');
  await expect(page.locator('[data-lane="1"]')).toContainText('Machine transliteration');
  await page.locator('[data-view-id="print"]').click();
  await expect(page.locator('.lo-paper')).toContainText('Vaigyaaniq Times');
});

test('Rakhigarhi: sources, draft itinerary from activities, field-visit budget, provider auto-match', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.locator('.nav-item[data-view="rakhigarhi"]').click();
  await expect(page.locator('#rakhigarhiView')).toContainText('Independent concept prototype');
  await page.locator('[data-hr-tab="sources"]').click();
  await expect(page.locator('#rakhigarhiView')).toContainText('10.1016/j.cell.2019.08.048');

  await page.locator('[data-hr-tab="activities"]').click();
  await page.locator('[data-add="local-welcome"]').click();
  await expect(page.locator('[data-add="local-welcome"]')).toHaveText('In your draft');
  await page.locator('[data-hr-tab="itinerary"]').click();
  await expect(page.locator('#rakhigarhiView')).toContainText('Community welcome');
  await expect(page.locator('#rakhigarhiView')).toContainText('₹35,137');
  await page.locator('#hrHead').fill('10');
  await page.locator('#hrHead').dispatchEvent('change');
  await expect(page.locator('#rakhigarhiView')).toContainText('10 attendees: ₹59,664');

  await page.locator('[data-hr-tab="providers"]').click();
  await page.locator('#hrProvForm [name=name]').fill('Test Runner Co');
  await page.locator('#hrProvForm [name=roles]').fill('runner');
  await page.locator('#hrProvForm [name=rate]').fill('2000');
  await page.locator('#hrProvForm [name=verified]').check();
  await page.locator('#hrProvForm button[type=submit]').click();
  await expect(page.locator('#rakhigarhiView .hr-table')).toContainText('Test Runner Co');
});
