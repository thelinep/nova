const { test, expect } = require('@playwright/test');

const palette = page => page.locator('#cmdkModal');

test('Cmd/Ctrl+K opens the palette, filters views and opens one with Enter', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette(page)).toHaveClass(/open/);
  await expect(page.locator('#cmdkInput')).toBeFocused();
  await expect(page.locator('#cmdkList .cmdk-group').first()).toHaveText('Actions');
  await page.keyboard.type('radh');
  await expect(page.locator('#cmdkList .cmdk-item[aria-selected="true"]')).toContainText('Radheya');
  await page.keyboard.press('Enter');
  await expect(palette(page)).not.toHaveClass(/open/);
  await expect(page.locator('#radheyaView')).toHaveClass(/active/);
});

test('arrow keys move the selection, Escape closes, and a media tab opens on its tab', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('zzqqxx');
  await expect(page.locator('#cmdkList .empty-hint')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette(page)).not.toHaveClass(/open/);

  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('video');
  const first = await page.locator('#cmdkList .cmdk-item').first().textContent();
  expect(first).toContain('Video');
  await page.keyboard.press('Enter');
  await expect(page.locator('#mediaView')).toHaveClass(/active/);
  await expect(page.locator('.nav-item[data-view="media"][data-media-tab="video"]')).toHaveClass(/active/);

  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#cmdk-opt-1')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#cmdk-opt-0')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette(page)).not.toHaveClass(/open/);
});

test('the New session action creates a session from the palette', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const before = await page.evaluate(() => DB.sessions.length);
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('new session');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => DB.sessions.length)).toBe(before + 1);
  await expect(page.locator('#consoleView')).toHaveClass(/active/);
});
