const { test, expect } = require('@playwright/test');

test.describe('Oversight', () => {
  test('the top bar shows the Workbench strip and setup pill, and links reach Workbench and the setup page', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#wb-strip-text')).toHaveText(/\d+ · \d+ · \d+ · kill: (clear|HALTED) · \d+/);
    await expect(page.locator('#wb-strip')).toHaveAttribute('title', /waiting for your decision/);
    await expect(page.locator('#act-text')).toHaveText(/setup: \d \/ 5/);
    await page.goto('/workbench.html');
    await expect(page.locator('.brand')).toContainText('NOVA Workbench');
    await expect(page.locator('#p-now')).not.toBeEmpty();
  });

  test('halting asks in an in-page dialog (no browser pop-up) and can be cancelled', async ({ page }) => {
    let popup = false;
    page.on('dialog', d => { popup = true; d.dismiss(); });
    await page.goto('/workbench.html');
    await page.locator('.btn-halt').click();
    await expect(page.locator('.wb-modal h3')).toHaveText('Halt NOVA');
    await expect(page.locator('.wb-modal input[type=password]')).toHaveCount(1);
    await page.locator('.wb-modal button', { hasText: 'cancel' }).click();
    await expect(page.locator('.wb-modal')).toHaveCount(0);
    expect(popup).toBe(false);
  });

  test('a /#view link opens that console view', async ({ page }) => {
    await page.goto('/#models');
    await expect(page.locator('#modelsView')).toHaveClass(/active/);
  });
});
