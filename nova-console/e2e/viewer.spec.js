const { test, expect } = require('@playwright/test');

// The app's window ignores links that open a new tab, so images open in NOVA's own viewer.
test('viewer: clicking an image opens it full size, arrows step through, Esc closes', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => setPrefs({ helperEnabled: false }));
  await page.evaluate(() => {
    const pad = document.createElement('div'); pad.className = 'view-pad'; pad.id = 'nvTest';
    pad.innerHTML = ['agents.jpg', 'activity.jpg', 'automations.jpg'].map(f => `<a href="/help/media/${f}" target="_blank" rel="noopener"><img src="/help/media/${f}" alt="${f}" style="width:60px"></a>`).join('');
    document.body.prepend(pad);
  });
  await page.locator('#nvTest img[alt="activity.jpg"]').click();
  const viewer = page.locator('#novaViewer');
  await expect(viewer).toBeVisible();
  await expect(page.locator('#nvStage img')).toHaveAttribute('src', /activity\.jpg/);
  await expect(page.locator('#nvCount')).toHaveText('2 of 3');
  expect(page.context().pages().length).toBe(1);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#nvStage img')).toHaveAttribute('src', /automations\.jpg/);
  await page.locator('#nvPrev').click();
  await page.locator('#nvPrev').click();
  await expect(page.locator('#nvStage img')).toHaveAttribute('src', /agents\.jpg/);
  await expect(page.locator('#nvDownload')).toHaveAttribute('href', /agents\.jpg/);
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
});
