const { test, expect } = require('@playwright/test');

test('Models: example rows are tucked away and marked; several loaded models raise a memory note', async ({ page, request }) => {
  await page.goto('/');
  await page.waitForTimeout(1500); // let the first load finish seeding
  const put = m => request.put('/api/store/models', { data: m, headers: { Origin: new URL(page.url()).origin } });
  for (const m of await (await request.get('/api/store/models')).json()) await put({ ...m, example: true, loaded: false });
  await put({ id: 'a:1', name: 'a:1', runtime: 'ollama', format: 'GGUF', quant: 'Q4', params: '7B', loaded: true, ramGb: 6, ramMeasured: true, gpuLayers: '100% on GPU', digest: 'x', expiresAt: new Date(Date.now() + 200000).toISOString() });
  await put({ id: 'b:1', name: 'b:1', runtime: 'ollama', format: 'GGUF', quant: 'Q4', params: '3B', loaded: true, ramGb: 3, ramMeasured: true, gpuLayers: '100% on GPU', digest: 'y' });
  await page.reload();
  await page.locator('.nav-item[data-view="models"]').click();
  await expect(page.locator('#modelCardGrid .model-card')).toHaveCount(2);
  await expect(page.locator('#modelMemWarn')).toContainText('2 models are loaded at once');
  await expect(page.locator('#modelCardGrid')).toContainText('In memory');
  await expect(page.locator('#modelCardGrid')).toContainText('100% on GPU');
  await expect(page.locator('#modelExamples summary')).toContainText('example models');
  await page.locator('#modelExamples summary').click();
  await expect(page.locator('#modelExamples .badge').first()).toHaveText(/Example/i);
  await page.locator('#modelRemoveExamples').click();
  await expect(page.locator('#modelExamples')).toHaveCount(0);
});
