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

test('Lipi OS: letters board with preview, sound, grammar, region and resources', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.locator('.nav-item[data-view="lipios"]').click();
  await page.locator('[data-lo-tab="letters"]').click();
  await expect(page.locator('#lipiosView .lt-tile').first()).toBeVisible();
  const total = await page.locator('#lipiosView .lt-tile').count();
  expect(total).toBeGreaterThan(100);
  await page.locator('#ltAuto').uncheck();
  await page.locator('.lt-tile[data-ch="घ"]').click();
  await expect(page.locator('.lt-big')).toContainText('घ');
  await expect(page.locator('.lt-side')).toContainText('महाप्राण');
  await expect(page.locator('.lt-side')).toContainText('झष्');
  await expect(page.locator('#ltPlay')).toBeVisible();
  await page.locator('#ltScript').selectOption('Brah');
  await expect(page.locator('.lt-big')).toContainText('𑀖');
  await page.locator('[data-board="टवर्ग · Retroflexes"]').click();
  await expect(page.locator('#lipiosView .lt-tile')).toHaveCount(5);
  await page.locator('[data-board=""]').click();
  await page.locator('#ltRegion').selectOption('Maldives');
  expect(await page.locator('#lipiosView .lt-tile').count()).toBeLessThan(total);
  const res = await page.request.get('/lipi-sounds/u0918.mp3');
  expect(res.status()).toBe(200);
});

test('Lipi OS: conjunct editor drags, snaps, saves and resizes', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.locator('.nav-item[data-view="lipios"]').click();
  await page.locator('[data-lo-tab="conjuncts"]').click();
  await expect(page.locator('#cjSvg')).toBeVisible();
  await page.locator('[data-cj-up="क"]').click();
  await page.locator('[data-cj-low="त"]').click();
  await expect(page.locator('#cjFontPreview')).not.toBeEmpty();
  await page.locator('#cjSvg').focus();
  await page.keyboard.press('ArrowRight');
  await page.locator('#cjSvg').focus();
  await page.keyboard.press('Shift+ArrowDown');
  await expect(page.locator('#cjDx')).toHaveValue('10');
  await expect(page.locator('#cjDy')).toHaveValue('-50');
  const box = await page.locator('#cjSub circle').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const k = (await page.locator('#cjSvg').boundingBox()).width / 1600; // screen pixels per font unit
  await page.mouse.move(box.x + box.width / 2 + 3 * k, box.y + box.height / 2 - 40 * k, { steps: 5 }); // near the line: it sticks
  await page.mouse.up();
  await expect(page.locator('#cjDy')).toHaveValue('0');
  await page.locator('[data-snap]').first().click();
  await expect(page.locator('[data-snap]').first()).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-nudge="0,10"]').click();
  await page.locator('#cjSave').click();
  await expect(page.locator('#lipiosView')).toContainText('Saved.');
  const saved = await (await page.request.get('/api/lipi/conjuncts')).json();
  expect(saved.overrides.Brah.pairs['क+त'].dy).toBe(10);
  await page.locator('#cjAuto').click();
  await page.locator('#cjSave').click();
  await expect(page.locator('#lipiosView')).toContainText('None yet.');
});

test('Lipi OS: Brahmi gallery filters, opens an item with its credit', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.locator('.nav-item[data-view="lipios"]').click();
  await page.locator('[data-lo-tab="gallery"]').click();
  await expect(page.locator('.bg-tile').first()).toBeVisible();
  const total = await page.locator('.bg-tile').count();
  expect(total).toBeGreaterThan(50);
  await page.locator('[data-gv="tamil"]').click();
  expect(await page.locator('.bg-tile').count()).toBeLessThan(total);
  await page.locator('.bg-tile[data-gi="mangulam"]').click();
  await expect(page.locator('#bgDetail')).toContainText('Mangulam');
  await expect(page.locator('#bgDetail')).toContainText('CC BY-SA 3.0');
  await expect(page.locator('#bgDetail a[href^="https://commons.wikimedia.org/wiki/File:"]')).toHaveCount(2);
  expect(await page.locator('#bgDetail img').evaluate(i => i.naturalWidth)).toBeGreaterThan(100);
  await page.locator('#bgClose').click();
  await page.locator('[data-gv=""]').click();
  await page.locator('#bgQ').fill('Kalinga');
  await page.locator('#bgQ').press('Enter');
  await expect(page.locator('.bg-tile[data-gi="dhauli"]')).toBeVisible();
});

test('Lipi OS: Brahmi gallery shows the machine reading of an inscription', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.locator('.nav-item[data-view="lipios"]').click();
  await page.locator('[data-lo-tab="gallery"]').click();
  await page.locator('.bg-tile[data-gi="lumbini"]').click();
  await expect(page.locator('#bgDetail .bg-ocr').last()).toBeVisible();
  await expect(page.locator('#bgDetail .bg-pill')).toContainText('Draft reading');
  expect(await page.locator('#bgDetail .bg-lines li').count()).toBeGreaterThanOrEqual(4);
  await expect(page.locator('#bgDetail .bg-lines li').first().locator('.d')).not.toBeEmpty();
  await page.locator('#bgClose').click();
  await page.locator('.bg-tile[data-gi="bower"]').click();
  await expect(page.locator('#bgDetail')).toContainText('not reliable');
});

test('Lipi OS: Brahmi report with detected areas on the picture', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.locator('.nav-item[data-view="lipios"]').click();
  await page.locator('[data-lo-tab="gallery"]').click();
  await page.locator('.bg-tile[data-gi="lumbini"]').click();
  await expect(page.locator('#bgDetail .bg-ov polygon').first()).toBeAttached();
  const before = await page.locator('#bgDetail .bg-ov polygon').count();
  await page.locator('[data-layer="akshar"]').click();
  expect(await page.locator('#bgDetail .bg-ov polygon').count()).toBeGreaterThan(before);
  await expect(page.locator('#bgDetail')).toContainText('धातुपाठ');
  await page.locator('#bgDetail .bg-find').first().click();
  await expect(page.locator('#bgDetail .bg-ov polygon.hl').first()).toBeAttached();
  await page.locator('[data-gview="report"]').click();
  await expect(page.locator('.bg-report')).toContainText('धातु');
  await expect(page.locator('.bg-report')).toContainText('संज्ञा');
  await page.locator('.bg-report [data-rgo="lumbini"]').first().click();
  await expect(page.locator('#bgDetail')).toContainText('Lumbini');
});
