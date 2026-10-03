const { test, expect } = require('@playwright/test');
const fs = require('node:fs');

const fixtureRoot = '/private/tmp/nova-e2e-workspace';
const digestQualified = 'a'.repeat(64);
const digestUnqualified = 'b'.repeat(64);

function qualification(digest, capabilities) {
  return {
    id: `qualification-${digest.slice(0, 8)}`,
    digest,
    capabilities: Object.fromEntries(['single-file', 'multi-file', 'large-context', 'clarification', 'timeout', 'cancellation'].map(name => [name, {
      capability: name, trials: capabilities.includes(name) ? 3 : 0,
      passes: capabilities.includes(name) ? 3 : 0, failures: 0,
      qualified: capabilities.includes(name),
    }])),
  };
}

async function openStudio(page, { roots = [], readiness = 'ready', planError = null, deferredPreview = false, deferredPlan = false } = {}) {
  const base = 'http://127.0.0.1:8791';
  const headers = { Origin: base };
  let releasePreview, releasePlan, previewStarted, planStarted;
  const previewHasStarted = new Promise(resolve => { previewStarted = resolve; });
  const planHasStarted = new Promise(resolve => { planStarted = resolve; });
  await page.route('**/api/workspace/roots', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: roots });
    return route.continue();
  });
  await page.route('**/api/model-qualifications', route => route.fulfill({ json: [
    qualification(digestQualified, ['single-file', 'multi-file', 'large-context', 'clarification', 'timeout', 'cancellation']),
    qualification(digestUnqualified, []),
  ] }));
  await page.route('**/api/agents/team', route => route.fulfill({ json: {
    generated_at: new Date().toISOString(), agents: [], tasks: [], controls: {
      runtime_halted: false, execution_available: false, execution_reason: 'agent_job_bridge_not_registered',
      human_result_review_available: false, human_result_review_reason: 'agent_result_review_state_not_implemented',
    },
  } }));
  await page.route('**/api/workspace/code-plan/preview', async route => {
    const body = route.request().postDataJSON();
    if (deferredPreview) { previewStarted(); await new Promise(resolve => { releasePreview = resolve; }); }
    if (readiness === 'error') return route.fulfill({ status: 503, json: { error: 'Ollama is not currently available.' } });
    if (readiness === 'unqualified' || body.modelId === 'unqualified-coder') return route.fulfill({ json: {
      ready: false, blocker: 'Selected model is not qualified for single-file coding. Run coding checks for this exact model.',
      requiredWorkflow: 'single-file', plannedFiles: ['feature.js'], qualification: null,
    } });
    return route.fulfill({ json: {
      ready: true, requiredWorkflow: 'multi-file', selectedModel: { id: 'guru-code-local', name: 'Guru-Code local', digest: digestQualified },
      qualification: { capability: 'multi-file', qualified: true }, plannedFiles: ['feature.js','draft.json'],
      repositoryScope: { observedFiles: 4, presentedFiles: ['feature.js','draft.json'], omittedFiles: [], truncated: false },
    } });
  });
  await page.route('**/api/workspace/code-plan', async route => {
    if (deferredPlan) { planStarted(); await new Promise(resolve => { releasePlan = resolve; }); }
    if (planError) return route.fulfill({ status: 409, json: { error: planError } });
    const body = route.request().postDataJSON();
    const response = await page.request.post(`${base}/api/workspace/change-batches`, {
      headers,
      data: { rootId: body.rootId, summary: 'Enable the requested feature', changes: [
        { relativePath: 'feature.js', find: 'false', replacement: 'true', impact: 'Turn on the requested feature.' },
        { relativePath: 'draft.json', find: '0.1.0', replacement: '0.1.1', impact: 'Record the matching fixture version.' },
      ] },
    });
    expect(response.ok()).toBeTruthy();
    const proposal = await response.json();
    proposal.modelId = body.modelId;
    expect(body.modelId).toBe('guru-code-local');
    expect(body.request).toContain('Keep programming syntax, keywords, and identifiers conventional.');
    return route.fulfill({ status: 201, json: proposal });
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    DB.models = [
      { id:'guru-code-local', name:'Guru-Code local', runtime:'ollama', digest:'a'.repeat(64), details:{parameter_size:'7B'}, contextLength:8192 },
      { id:'unqualified-coder', name:'Unqualified coder', runtime:'ollama', digest:'b'.repeat(64), details:{parameter_size:'7B'}, contextLength:8192 },
    ];
  });
  await page.locator('[data-view="codingstudio"]').click();
  await expect(page.getByRole('heading', { name: 'Coding Studio' })).toBeVisible();
  return {
    previewHasStarted,
    releasePreview: () => releasePreview?.(),
    planHasStarted,
    releasePlan: () => releasePlan?.(),
  };
}

async function approveFixtureRoot(page) {
  const response = await page.request.post('http://127.0.0.1:8791/api/workspace/roots', {
    headers: { Origin: 'http://127.0.0.1:8791' }, data: { path: fixtureRoot, label: 'Studio E2E project' },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function fillCodingTask(page) {
  await page.getByLabel('Local coding model').selectOption('guru-code-local');
  await page.getByLabel('What should change?').fill('In feature.js, change enabled to true and in draft.json change the version to 0.1.1 so the feature and its version are updated together.');
}

test('Coding Studio gives a clear empty state when no project is approved', async ({ page }) => {
  await openStudio(page);
  await expect(page.getByRole('heading', { name: 'Approve a project to begin' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Local Workspace' })).toBeVisible();
  await expect(page.locator('#studioCreateProposal')).toBeDisabled();
  await expect(page.getByText(/no trained Guru-Code checkpoint/i)).toBeVisible();
});

test('unqualified model is identified and blocked by the read-only readiness gate', async ({ page }) => {
  const root = await approveFixtureRoot(page);
  await openStudio(page, { roots: [root], readiness: 'unqualified' });
  await page.getByLabel('Local coding model').selectOption('unqualified-coder');
  await page.getByLabel('What should change?').fill('In feature.js, change enabled to true so the feature is enabled by default.');
  await page.getByRole('button', { name: 'Check readiness' }).click();
  await expect(page.locator('#studioReadiness')).toContainText('not qualified for single-file coding');
  await expect(page.getByRole('button', { name: 'Create proposal' })).toBeDisabled();
  await expect(page.locator('#studioModelSummary')).toContainText('0/6 coding checks qualified');
  await page.request.delete(`http://127.0.0.1:8791/api/workspace/roots/${encodeURIComponent(root.id)}`, { headers: { Origin: 'http://127.0.0.1:8791' } });
});

test('qualified task creates a proposal, then uses existing check, approval, apply and rollback controls', async ({ page }) => {
  const root = await approveFixtureRoot(page);
  await openStudio(page, { roots: [root] });
  await fillCodingTask(page);
  await expect(page.getByLabel('Brahmi comments and explanations')).toBeChecked();
  await page.getByRole('button', { name: 'Check readiness' }).click();
  await expect(page.locator('#studioReadiness')).toContainText('Ready for a code proposal');
  await expect(page.locator('#studioReadiness')).toContainText('feature.js');
  await page.getByRole('button', { name: 'Create proposal' }).click();
  await expect(page.getByRole('heading', { name: 'Proposal ready for review' })).toBeVisible();
  await expect(page.getByText('No project write has occurred')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply atomically' })).toHaveCount(0);
  expect(fs.readFileSync(`${fixtureRoot}/feature.js`, 'utf8')).toContain('false');

  await page.getByRole('button', { name: 'Review exact diff and checks in Local Workspace' }).click();
  await expect(page.getByLabel('Combined batch diff')).toContainText('+const enabled = true;');
  await expect(page.getByRole('button', { name: 'Validate entire batch' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve exact batch' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Apply atomically' })).toHaveCount(0);
  expect(fs.readFileSync(`${fixtureRoot}/feature.js`, 'utf8')).toContain('false');

  await page.getByRole('button', { name: 'Validate entire batch' }).click();
  await expect(page.getByRole('button', { name: 'Approve exact batch' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply atomically' })).toHaveCount(0);
  expect(fs.readFileSync(`${fixtureRoot}/feature.js`, 'utf8')).toContain('false');
  await page.getByRole('button', { name: 'Approve exact batch' }).click();
  await expect(page.getByRole('button', { name: 'Apply atomically' })).toBeVisible();
  expect(fs.readFileSync(`${fixtureRoot}/feature.js`, 'utf8')).toContain('false');
  await page.getByRole('button', { name: 'Apply atomically' }).click();
  await expect(page.getByText('Applied 2 change(s).')).toBeVisible();
  expect(fs.readFileSync(`${fixtureRoot}/feature.js`, 'utf8')).toContain('true');
  await page.getByRole('button', { name: 'Roll back batch' }).click();
  await expect(page.getByText('Rolled back — every file restored to its pre-batch state.')).toBeVisible();
  expect(fs.readFileSync(`${fixtureRoot}/feature.js`, 'utf8')).toContain('false');
  await page.request.delete(`http://127.0.0.1:8791/api/workspace/roots/${encodeURIComponent(root.id)}`, { headers: { Origin: 'http://127.0.0.1:8791' } });
});

test('readiness becomes stale when the request changes and planning errors keep writes gated', async ({ page }) => {
  const root = await approveFixtureRoot(page);
  await openStudio(page, { roots: [root], planError: 'Source changed after readiness was checked.' });
  await fillCodingTask(page);
  await page.getByRole('button', { name: 'Check readiness' }).click();
  await expect(page.getByRole('button', { name: 'Create proposal' })).toBeEnabled();
  await page.getByLabel('What should change?').fill('In feature.js, change enabled to false so the feature is disabled by default.');
  await expect(page.locator('#studioReadiness')).toContainText('Inputs changed. Check readiness again');
  await expect(page.getByRole('button', { name: 'Create proposal' })).toBeDisabled();
  await page.getByRole('button', { name: 'Check readiness' }).click();
  await expect(page.getByRole('button', { name: 'Create proposal' })).toBeEnabled();
  await page.getByRole('button', { name: 'Create proposal' }).click();
  await expect(page.getByRole('alert')).toContainText('project changed after readiness was checked');
  await expect(page.getByRole('button', { name: 'Create proposal' })).toBeDisabled();
  expect(fs.readFileSync(`${fixtureRoot}/feature.js`, 'utf8')).toContain('false');
  await page.request.delete(`http://127.0.0.1:8791/api/workspace/roots/${encodeURIComponent(root.id)}`, { headers: { Origin: 'http://127.0.0.1:8791' } });
});

test('a delayed readiness response cannot restore readiness after the task changes', async ({ page }) => {
  const root = await approveFixtureRoot(page);
  const studio = await openStudio(page, { roots: [root], deferredPreview: true });
  await fillCodingTask(page);
  await page.getByRole('button', { name: 'Check readiness' }).click();
  await studio.previewHasStarted;
  await page.getByLabel('What should change?').fill('In feature.js, change enabled to false while the first check is pending.');
  studio.releasePreview();
  await expect(page.locator('#studioReadiness')).toContainText('Inputs changed. Check readiness again');
  await expect(page.getByRole('button', { name: 'Create proposal' })).toBeDisabled();
  await page.request.delete(`http://127.0.0.1:8791/api/workspace/roots/${encodeURIComponent(root.id)}`, { headers: { Origin: 'http://127.0.0.1:8791' } });
});

test('a delayed proposal cannot replace the UI after the task changes', async ({ page }) => {
  const root = await approveFixtureRoot(page);
  const studio = await openStudio(page, { roots: [root], deferredPlan: true });
  await fillCodingTask(page);
  await page.getByRole('button', { name: 'Check readiness' }).click();
  await expect(page.getByRole('button', { name: 'Create proposal' })).toBeEnabled();
  await page.getByRole('button', { name: 'Create proposal' }).click();
  await studio.planHasStarted;
  await page.getByLabel('What should change?').fill('In feature.js, change enabled to false while planning is pending.');
  studio.releasePlan();
  await expect(page.locator('#studioCreateProposal')).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Proposal ready for review' })).toHaveCount(0);
  expect(fs.readFileSync(`${fixtureRoot}/feature.js`, 'utf8')).toContain('false');
  await page.request.delete(`http://127.0.0.1:8791/api/workspace/roots/${encodeURIComponent(root.id)}`, { headers: { Origin: 'http://127.0.0.1:8791' } });
});

test('Studio exposes multi-agent blockers truthfully and remains keyboard usable at 390px', async ({ page }) => {
  const root = await approveFixtureRoot(page);
  await openStudio(page, { roots: [root] });
  await expect(page.getByText('Agent execution unavailable: the agent job bridge is not connected')).toBeVisible();
  await expect(page.getByText('Human result review unavailable: agent result review is not available yet')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.locator('#rail')).toHaveClass(/open/);
  await page.locator('#rail [data-view="codingstudio"]').click();
  await expect(page.locator('#rail')).not.toHaveClass(/open/);
  await page.waitForTimeout(250);
  await expect(page.getByRole('heading', { name: 'Coding Studio' })).toBeVisible();
  await page.getByLabel('Approved project').focus();
  await expect(page.getByLabel('Approved project')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Local coding model')).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect.poll(() => page.evaluate(() => document.querySelector('#codingstudioView').scrollWidth <= document.querySelector('#codingstudioView').clientWidth)).toBe(true);
  await page.request.delete(`http://127.0.0.1:8791/api/workspace/roots/${encodeURIComponent(root.id)}`, { headers: { Origin: 'http://127.0.0.1:8791' } });
});
