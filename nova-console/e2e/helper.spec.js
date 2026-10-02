const { test, expect } = require('@playwright/test');

test('helper: opens from the corner, runs a walkthrough, and can be hidden and shown again', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => setPrefs({ helperSpeak: false, helperEnabled: true }));
  await page.reload();
  await expect(page.locator('#hfFace')).toBeVisible();
  await page.locator('#hfFace').click();
  await expect(page.locator('#hfPanel')).toBeVisible();
  await expect(page.locator('#hfOpts')).toBeHidden();
  await page.locator('.hf-chip', { hasText: 'Let Maataa read a folder in chat' }).click();
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

test('helper: design Nova: face, traits and a preset change the avatar and persona', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => setPrefs({ helperSpeak: false, helperEnabled: true, helperCharacter: null }));
  await page.reload();
  await expect(page.locator('#hfFace svg')).toBeVisible();
  await page.locator('#hfFace').click();
  await page.locator('#hfOptsBtn').click();
  await page.locator('#hfDesign').click();
  await expect(page.locator('#actionModalTitle')).toHaveText('Design Nova');
  await page.locator('[data-eyes="happy"]').click();
  await page.locator('[data-extra="glasses"]').click();
  await page.locator('[data-color="#6ee7b7"]').click();
  await page.locator('[data-preset="guide"]').click();
  await expect(page.locator('#ndSum')).toContainText('Warm and caring');
  await page.locator('#ndT_brevity').fill('95');
  await expect(page.locator('#ndSum')).toContainText('Very brief');
  await page.locator('#ndSave').click();
  await expect(page.locator('#actionModal')).not.toHaveClass(/open/);
  const nova = await page.evaluate(() => fetch('/api/characters').then(r => r.json()).then(l => l.find(c => c.id === 'nova')));
  expect(nova.avatar.face).toMatchObject({ eyes: 'happy', extra: 'glasses', color: '#6ee7b7' });
  expect(nova.traits.brevity).toBe(95);
  await expect(page.locator('#hfFace svg circle')).toHaveCount(2); // the glasses
  await expect(page.locator('#hfMouth')).toHaveAttribute('stroke', '#6ee7b7');
  // Back to the original
  await page.locator('#hfFace').click();
  await page.locator('#hfDesign').click();
  await page.locator('#ndReset').click(); await page.locator('#ndReset').click();
  await expect.poll(() => page.evaluate(() => fetch('/api/characters').then(r => r.json()).then(l => l.find(c => c.id === 'nova').avatar.face.eyes))).toBe('round');
});
