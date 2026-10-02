const { test, expect } = require('@playwright/test');

test('Local Workspace shows this device and a verified contract chain', async ({ page }) => {
  await page.goto('/');
  await page.locator('.nav-item[data-view="workspace"]').click();
  const panel = page.locator('#contractsPanel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Workstation');
  await expect(panel.locator('#contractChainState')).toHaveText('Chain verified');
  await expect(panel).toContainText('process.execute');
});
