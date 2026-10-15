const { test, expect } = require('@playwright/test');

const listing = running => ({
  freeGb: 12, memoryGb: 18, platform: 'darwin', running: running ? { id: 'kokoro', jobId: 'j1' } : null,
  components: [
    { id: 'ollama', group: 'Core', label: 'Ollama', what: 'Runs the local language models.', sizeGb: 0.5, needGb: 1, installKind: 'link', url: 'https://ollama.com/download', state: 'installed', detail: '3 model(s)', blockers: [], canInstall: false },
    { id: 'model-qwen2-5-coder-7b', group: 'Core', label: 'qwen2.5-coder:7b', what: 'Coding model.', sizeGb: 4.7, needGb: 7, installKind: 'pull', state: 'installed', detail: 'Coding checks not run yet.', qualify: true, blockers: [], canInstall: false },
    { id: 'kokoro', group: 'Sound', label: 'Kokoro voices', what: 'Natural offline voices.', sizeGb: 0.4, needGb: 1, installKind: 'script', state: running ? 'missing' : 'missing', blockers: [], canInstall: true },
    { id: 'ltx', group: 'Video', label: 'LTX-2 video with sound', what: 'Short clips.', sizeGb: 28, needGb: 31, installKind: 'script', state: 'missing', blockers: ['needs 31 GB free; 12 GB is free'], canInstall: false },
  ],
});

test('the Install page shows each component and installs one on a click', async ({ page }) => {
  let running = false, posted = null, qualified = null;
  await page.route('**/api/installers', route => route.fulfill({ json: listing(running) }));
  await page.route('**/api/installers/kokoro/install', route => { posted = 'kokoro'; running = true; return route.fulfill({ status: 202, json: { started: true, jobId: 'j1' } }); });
  await page.route('**/api/installers/kokoro/log', route => route.fulfill({ json: { log: '== Downloading voices\n42%' } }));
  await page.route('**/api/models/qualify', route => { qualified = route.request().postDataJSON(); return route.fulfill({ status: 202, json: { jobId: 'q1' } }); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.locator('[data-view="install"]').click();
  await expect(page.getByRole('heading', { name: 'Install', exact: true })).toBeVisible();
  await expect(page.locator('#insSummary')).toContainText('12 GB free');
  const ltx = page.locator('.ins-card[data-id="ltx"]');
  await expect(ltx).toContainText("Can't install yet: needs 31 GB free");
  await expect(ltx.getByRole('button', { name: /^Install/ })).toHaveCount(0);
  await page.locator('.ins-card[data-id="model-qwen2-5-coder-7b"]').getByRole('button', { name: 'Run the coding checks' }).click();
  await expect.poll(() => qualified && qualified.model).toBe('qwen2.5-coder:7b');
  await page.locator('.ins-card[data-id="kokoro"]').getByRole('button', { name: /Install · 400 MB/ }).click();
  await expect.poll(() => posted).toBe('kokoro');
  await expect(page.locator('#insSummary')).toContainText('Installing Kokoro voices');
  await expect(page.locator('.ins-card[data-id="kokoro"] .ins-logbox')).toContainText('Downloading voices');
});
