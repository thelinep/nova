const { test, expect } = require('@playwright/test');

const digest = 'c'.repeat(64);
function qualified() {
  return [{ id: 'q-app', digest, capabilities: Object.fromEntries(['single-file', 'multi-file', 'large-context', 'clarification', 'timeout', 'cancellation'].map(name => [name, { capability: name, trials: 3, passes: 3, failures: 0, qualified: true }])) }];
}

async function open(page) {
  await page.route('**/api/model-qualifications', route => route.fulfill({ json: qualified() }));
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.evaluate(d => { DB.models = [{ id: 'qwen2.5-coder:7b', name: 'qwen2.5-coder:7b', runtime: 'ollama', digest: d, details: { parameter_size: '7.6B' }, contextLength: 32768 }]; }, digest);
}

test('describe an app, see the exact plan, build, approve, apply and run it', async ({ page }) => {
  await open(page);
  await page.locator('[data-view="codingstudio"]').click();
  const panel = page.locator('#appBuilder');
  await expect(panel.getByRole('heading', { name: 'Build a new app' })).toBeVisible();
  await panel.getByRole('button', { name: /^Use / }).click();
  await expect(panel.locator('#abParent')).toContainText('Maataa Projects');
  await panel.locator('#abDescription').fill('A tip calculator: enter the bill and see a 15% tip');
  await panel.getByRole('button', { name: 'Prepare the plan' }).click();
  await expect(panel.locator('#abBuild')).toHaveAttribute('data-status', 'drafted');
  await expect(panel.locator('#abRequest')).toContainText('Update index.html, styles.css and main.js');
  await expect(panel).toContainText('tip-calculator-enter-bill');

  // The model run itself is simulated: the build becomes ready with a checked batch.
  const buildId = await page.evaluate(() => appBuilderState.buildId);
  let state = 'building';
  const build = () => ({ ...appBuilderStateSnapshot, status: state, loopId: 'loop_x', batchId: 'batch_x',
    loop: { id: 'loop_x', status: state === 'building' ? 'running' : 'ready', phase: state === 'building' ? 'testing' : null, attempts: [{ number: 1, status: 'tests-failed', test: { status: 'failed', outputTail: 'expected tip' } }, ...(state === 'building' ? [] : [{ number: 2, status: 'passed', test: { status: 'passed' } }])] },
    batch: { id: 'batch_x', status: state === 'approved' ? 'approved' : 'checks-passed', files: ['index.html', 'main.js', 'styles.css'], checks: [{ name: 'Batch tests', status: 'passed' }] } });
  const appBuilderStateSnapshot = await page.evaluate(() => appBuilderState.build);
  await page.route(`**/api/app-builder/builds/${buildId}/start`, route => route.fulfill({ status: 202, json: build() }));
  await page.route(`**/api/app-builder/builds/${buildId}`, route => route.fulfill({ json: { ...build(), status: state === 'approved' ? 'ready' : state } }));
  await page.route('**/api/workspace/change-batches/batch_x/approve', route => { state = 'approved'; return route.fulfill({ json: { ok: true } }); });
  await page.route('**/api/workspace/change-batches/batch_x/execute', route => { state = 'applied'; return route.fulfill({ json: { ok: true } }); });
  await page.route('**/api/workspace/runs', route => route.fulfill({ json: { id: 'run_x', status: 'running', url: null } }));
  await page.route('**/api/workspace/runs/run_x', route => route.fulfill({ json: { id: 'run_x', status: 'running', url: 'http://127.0.0.1:5173/' } }));

  await panel.getByRole('button', { name: 'Create the project and start building' }).click();
  await expect(panel.locator('#abBuild')).toHaveAttribute('data-status', 'building');
  await expect(panel.locator('#abAttemptsList')).toContainText('Attempt 1: tests-failed');
  state = 'ready';
  await expect(panel.locator('#abBuild')).toHaveAttribute('data-status', 'ready', { timeout: 6000 });
  await expect(panel).toContainText('Attempt 2: passed');
  await panel.getByRole('button', { name: 'Approve this exact batch' }).click();
  await panel.getByRole('button', { name: 'Apply to the project' }).click();
  await expect(panel.locator('#abBuild')).toHaveAttribute('data-status', 'applied');
  await panel.getByRole('button', { name: 'Run the app' }).click();
  await expect(panel.locator('#abOpenApp')).toHaveAttribute('href', 'http://127.0.0.1:5173/');
  await panel.getByRole('button', { name: 'Ask for the next change' }).click();
  await expect(page.locator('#studioRequest')).toBeFocused();
});

test('an unqualified model is named and can be sent for coding checks', async ({ page }) => {
  await page.route('**/api/model-qualifications', route => route.fulfill({ json: [] }));
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => { DB.models = [{ id: 'llama3:latest', name: 'llama3:latest', runtime: 'ollama', digest: 'd'.repeat(64) }]; });
  let asked = null;
  await page.route('**/api/models/qualify', route => { asked = route.request().postDataJSON(); return route.fulfill({ status: 202, json: { jobId: 'job_q' } }); });
  await page.locator('[data-view="codingstudio"]').click();
  const note = page.locator('#abQualifyNote');
  await expect(note).toContainText('llama3:latest has not passed the coding checks yet');
  await note.getByRole('button', { name: 'Run coding checks now' }).click();
  await expect.poll(() => asked?.model).toBe('llama3:latest');
});

test('asking in chat to build an app opens the App Builder with a drafted plan', async ({ page }) => {
  await open(page);
  await page.locator('[data-view="codingstudio"]').click();
  await page.locator('#appBuilder').getByRole('button', { name: /^Use / }).click();
  await expect(page.locator('#abParent')).toContainText('Maataa Projects');
  await page.locator('[data-view="console"]').click();
  await page.locator('#composer').fill('मेरे लिए एक नोट्स वेबसाइट बनाओ जिसमें खोज हो');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Coding Studio' })).toBeVisible();
  await expect(page.locator('#abBuild')).toHaveAttribute('data-status', 'drafted');
  await expect(page.locator('#abRequest')).toContainText('नोट्स वेबसाइट');
});
