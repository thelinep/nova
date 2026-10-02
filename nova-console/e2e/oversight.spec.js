const { test, expect } = require('@playwright/test');

test.describe('Oversight', () => {
  test('the top bar shows the Workbench strip and setup pill, and links reach Workbench and the setup page', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#wb-strip-text')).toHaveText(/\d+ · \d+ · \d+ · kill: (clear|HALTED) · \d+/);
    await expect(page.locator('#wb-strip')).toHaveAttribute('title', /waiting for your decision/);
    await expect(page.locator('#act-text')).toHaveText(/setup: \d \/ 5/);
    await page.goto('/workbench.html');
    await expect(page.locator('.brand')).toContainText('Maataa Workbench');
    await expect(page.locator('#p-now')).not.toBeEmpty();
  });

  test('halting asks in an in-page dialog (no browser pop-up) and can be cancelled', async ({ page }) => {
    let popup = false;
    page.on('dialog', d => { popup = true; d.dismiss(); });
    await page.goto('/workbench.html');
    await page.locator('.btn-halt').click();
    await expect(page.locator('.wb-modal h3')).toHaveText('Halt Maataa');
    await expect(page.locator('.wb-modal input[type=password]')).toHaveCount(1);
    await page.locator('.wb-modal button', { hasText: 'cancel' }).click();
    await expect(page.locator('.wb-modal')).toHaveCount(0);
    expect(popup).toBe(false);
  });

  test('a /#view link opens that console view', async ({ page }) => {
    await page.goto('/#models');
    await expect(page.locator('#modelsView')).toHaveClass(/active/);
  });

  test('Agent Browser: allow a website, see it listed, remove it', async ({ page }) => {
    await page.goto('/');
    await page.locator('.nav-item[data-view="agentbrowser"]').click();
    await expect(page.locator('#agentbrowserView .view-title')).toHaveText('Agent Browser');
    await expect(page.locator('#abStatus')).toContainText('Engine');
    await page.locator('#abDomain').fill('https://www.Example.org/page');
    await page.locator('#abAdd').click();
    await expect(page.locator('#abAllow')).toContainText('www.example.org');
    await page.locator('.ab-remove[data-d="www.example.org"]').click();
    await expect(page.locator('#abAllow')).not.toContainText('www.example.org');
  });
});
