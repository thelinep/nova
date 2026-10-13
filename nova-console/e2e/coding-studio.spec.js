const { test, expect } = require('@playwright/test');
const fs = require('node:fs');

const fixtureRoot = process.env.NOVA_E2E_WORKSPACE;
if (!fixtureRoot) throw new Error('NOVA_E2E_WORKSPACE must be set by Playwright config.');
const digestQualified = 'a'.repeat(64);
const digestUnqualified = 'b'.repeat(64);

test.beforeEach(() => {
  fs.writeFileSync(`${fixtureRoot}/feature.js`, 'const enabled = false;\n');
  fs.writeFileSync(`${fixtureRoot}/draft.json`, '{"version":"0.1.0"}\n');
});

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

async function openStudio(page, { roots = [], readiness = 'ready', planError = null, deferredPreview = false, deferredPlan = false, agentFlow = null, loopFlow = null, modelLabel = 'Guru-Code local', guruReadiness = null } = {}) {
  const base = 'http://127.0.0.1:8791';
  const headers = { Origin: base };
  let releasePreview, releasePlan, previewStarted, planStarted;
  const previewHasStarted = new Promise(resolve => { previewStarted = resolve; });
  const planHasStarted = new Promise(resolve => { planStarted = resolve; });
  await page.route('**/api/guru/readiness', route => route.fulfill({ json: guruReadiness || {
    schema: 'maataa-guru-readiness-v1', status: 'blocked', action: { enabled: false, reason: 'Unqualified candidate.' },
    entries: [{ id: 'checkpoint_qualification', label: 'Checkpoint qualification', status: 'blocked', summary: 'No trained Guru-Code checkpoint.', blockers: ['Exact-model coding capability is not established.'], evidence: [{ path: 'guru/data/coding/model.json', detail: 'No checkpoint recorded.' }] }],
  } }));
  await page.route('**/api/workspace/roots', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: roots });
    return route.continue();
  });
  await page.route('**/api/model-qualifications', route => route.fulfill({ json: [
    qualification(digestQualified, ['single-file', 'multi-file', 'large-context', 'clarification', 'timeout', 'cancellation']),
    qualification(digestUnqualified, []),
  ] }));
  await page.route('**/api/agents/team', route => route.fulfill({ json: agentFlow ? agentFlow.team() : {
    generated_at: new Date().toISOString(), agents: [], tasks: [], controls: {
      runtime_halted: false, execution_available: false, execution_reason: 'agent_job_bridge_not_registered',
      human_result_review_available: false, human_result_review_reason: 'agent_result_review_state_not_implemented',
    },
  } }));
  if (agentFlow) {
    await page.route('**/api/agents/coding/tasks', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON();
      expect(body.rootId).toBe(agentFlow.rootId);
      expect(body.modelId).toBe('guru-code-local');
      expect(body.request).toContain('Keep programming syntax, keywords, and identifiers conventional.');
      expect(body.brahmiComments).toBe(true);
      return route.fulfill({ status: 202, json: agentFlow.dispatch(body) });
    });
    await page.route('**/api/agents/tasks/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const taskId = url.pathname.split('/')[4];
      if (request.method() === 'GET' && !url.pathname.endsWith('/review') && !url.pathname.endsWith('/retry') && !url.pathname.endsWith('/cancel')) {
        return route.fulfill({ json: agentFlow.detail(taskId) });
      }
      if (request.method() === 'POST' && url.pathname.endsWith('/review')) {
        const body = request.postDataJSON();
        return route.fulfill({ json: { task: await agentFlow.review(taskId, body) } });
      }
      if (request.method() === 'POST' && url.pathname.endsWith('/retry')) {
        return route.fulfill({ json: { task: agentFlow.retry(taskId, request.postDataJSON()) } });
      }
      if (request.method() === 'POST' && url.pathname.endsWith('/cancel')) {
        return route.fulfill({ json: { task: agentFlow.cancel(taskId) } });
      }
      return route.continue();
    });
  }
  await page.route('**/api/workspace/code-plan/preview', async route => {
    const body = route.request().postDataJSON();
    if (deferredPreview) { previewStarted(); await new Promise(resolve => { releasePreview = resolve; }); }
    if (readiness === 'error') return route.fulfill({ status: 503, json: { error: 'Ollama is not currently available.' } });
    if (readiness === 'unqualified' || body.modelId === 'unqualified-coder') return route.fulfill({ json: {
      ready: false, blocker: 'Selected model is not qualified for single-file coding. Run coding checks for this exact model.',
      requiredWorkflow: 'single-file', plannedFiles: ['feature.js'], qualification: null,
    } });
    return route.fulfill({ json: {
      ready: true, requiredWorkflow: 'multi-file', selectedModel: { id: 'guru-code-local', name: modelLabel, digest: digestQualified },
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
  if (loopFlow) {
    await page.route('**/api/workspace/loops', async route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: loopFlow.list() });
      if (route.request().method() === 'POST') return route.fulfill({ status: 201, json: loopFlow.start(route.request().postDataJSON()) });
      return route.continue();
    });
    await page.route('**/api/workspace/loops/**', async route => {
      if (route.request().method() === 'POST' && route.request().url().endsWith('/cancel')) {
        return route.fulfill({ json: loopFlow.cancel() });
      }
      return route.continue();
    });
  }

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.evaluate((demoModelLabel) => {
    DB.models = [
      { id:'guru-code-local', name:demoModelLabel, runtime:'ollama', digest:'a'.repeat(64), details:{parameter_size:'7B'}, contextLength:8192 },
      { id:'unqualified-coder', name:'Unqualified coder', runtime:'ollama', digest:'b'.repeat(64), details:{parameter_size:'7B'}, contextLength:8192 },
    ];
  }, modelLabel);
  await page.locator('[data-view="codingstudio"]').click();
  await expect(page.getByRole('heading', { name: 'Coding Studio' })).toBeVisible();
  return {
    previewHasStarted,
    releasePreview: () => releasePreview?.(),
    planHasStarted,
    releasePlan: () => releasePlan?.(),
  };
}

function codingLoopFlow(rootId) {
  let loop = null;
  let starts = 0;
  let delayedCancel = false;
  let cancelPolls = 0;
  return {
    list: () => {
      if (delayedCancel && loop?.status === 'running' && cancelPolls > 0 && ++cancelPolls >= 3) {
        loop.status = 'cancelled'; loop.phase = null; loop.error = 'Cancelled.';
      }
      return loop ? [structuredClone(loop)] : [];
    },
    start: body => {
      starts++;
      expect(body.rootId).toBe(rootId);
      expect(body.modelId).toBe('guru-code-local');
      expect(body.request).toContain('Keep programming syntax, keywords, and identifiers conventional.');
      expect(body.maxAttempts).toBe(3);
      loop = {
        id: 'loop-coding-studio-e2e', type: 'dev-loop', rootId, modelId: body.modelId,
        request: body.request, maxAttempts: 3, status: 'running', phase: 'attempt 1: running tests',
        baseline: { status: 'passed', durationMs: 31, outputTail: '2 tests passed' },
        attempts: [{ number: 1, status: 'testing', plan: { summary: 'Fix the requested behavior.', operations: [{ operation: 'edit', relativePath: 'feature.js' }] }, test: { status: 'failed', durationMs: 18, outputTail: 'Expected true but received false' } }],
        batchId: null, error: null,
      };
      return structuredClone(loop);
    },
    cancel: () => {
      if (loop && delayedCancel) cancelPolls = 1;
      else if (loop) { loop.status = 'cancelled'; loop.phase = null; loop.error = 'Cancelled.'; }
      return structuredClone(loop);
    },
    deferCancellation: () => { delayedCancel = true; },
    seedReady: batchId => {
      loop = {
        id: 'loop-coding-studio-ready-e2e', type: 'dev-loop', rootId, modelId: 'guru-code-local',
        request: 'Create a tested-output.txt file with the expected content.', maxAttempts: 3,
        status: 'ready', phase: null,
        baseline: { status: 'passed', durationMs: 30, outputTail: '2 tests passed before changes' },
        attempts: [{ number: 1, status: 'passed', plan: { summary: 'Create the requested output.', operations: [{ operation: 'create', relativePath: 'tested-output.txt' }] }, test: { status: 'passed', durationMs: 22, outputTail: '2 tests passed after the change' } }],
        batchId, batchStatus: 'checks-passed', error: null,
      };
      return structuredClone(loop);
    },
    get starts() { return starts; },
  };
}

function codingAgentFlow(page, rootId) {
  let task = null;
  let batch = null;
  let sequence = 0;
  let exposeTaskControls = true;
  const controls = {
    runtime_halted: false, execution_available: true, execution_reason: null,
    human_result_review_available: true, human_result_review_reason: null,
  };
  const changes = [
    { operation: 'edit', relativePath: 'feature.js', find: 'const enabled = false;', replacement: 'const enabled = true;', impact: 'Enable the requested feature.' },
    { operation: 'edit', relativePath: 'draft.json', find: '0.1.0', replacement: '0.1.1', impact: 'Keep the fixture version aligned.' },
  ];
  const result = () => ({ proposal: { summary: 'Enable the requested feature.', changes, acceptanceChecks: [{ description: 'feature.js contains the enabled flag.' }] }, acceptanceChecks: [{ description: 'feature.js contains the enabled flag.' }], batchId: batch?.id || null });
  return {
    rootId,
    team: () => ({ generated_at: new Date().toISOString(), agents: [{ id: 'coding-worker', name: 'Coding worker', role: 'worker' }], tasks: task ? [{ id: task.id, state: task.state, codingStudio: true }] : [], controls }),
    dispatch: body => {
      sequence++;
      task = { id: `coding-task-e2e-${sequence}`, state: 'awaiting_result_review', codingStudio: true, rootId: body.rootId, modelId: body.modelId, batchId: null, result: result() };
      return { task };
    },
    detail: id => {
      if (id !== task?.id) return null;
      const detail = { task: structuredClone(task) };
      if (exposeTaskControls) detail.controls = { runtime_halted: controls.runtime_halted, retry_available: ['revision_requested', 'failed'].includes(task.state) && !controls.runtime_halted, cancel_available: ['queued', 'assigned', 'running'].includes(task.state) };
      return detail;
    },
    review: async (id, body) => {
      expect(id).toBe(task.id);
      expect(body.reason).toBeTruthy();
      if (body.decision === 'accept') {
        const response = await page.request.post('http://127.0.0.1:8791/api/workspace/change-batches', {
          headers: { Origin: 'http://127.0.0.1:8791' },
          data: { rootId, summary: 'Enable the requested feature.', changes },
        });
        expect(response.ok()).toBeTruthy();
        batch = await response.json();
        task.state = 'accepted'; task.batchId = batch.id; task.result.batchId = batch.id;
      } else if (body.decision === 'revise') task.state = 'revision_requested';
      else if (body.decision === 'reject') task.state = 'rejected';
      return structuredClone(task);
    },
    retry: (id, body) => { expect(id).toBe(task.id); expect(body.feedback).toBeTruthy(); task.state = 'running'; return structuredClone(task); },
    cancel: id => { expect(id).toBe(task.id); task.state = 'cancelled'; return structuredClone(task); },
    seedFailed: () => { sequence++; task = { id: `coding-task-e2e-${sequence}`, state: 'failed', codingStudio: true, rootId, modelId: 'guru-code-local', batchId: null, error: 'Coding task failed. Retry with specific feedback or check local runtime diagnostics.', result: result() }; },
    omitTaskControls: () => { exposeTaskControls = false; },
    controls,
  };
}

async function approveFixtureRoot(page) {
  const response = await page.request.post('http://127.0.0.1:8791/api/workspace/roots', {
    headers: { Origin: 'http://127.0.0.1:8791' }, data: { path: fixtureRoot, label: 'Studio E2E project' },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function rootBatches(page, rootId) {
  const response = await page.request.get('http://127.0.0.1:8791/api/workspace/change-batches', { headers: { Origin: 'http://127.0.0.1:8791' } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).filter(batch => batch.rootId === rootId);
}

async function fillCodingTask(page) {
  await page.getByLabel('Local coding model').selectOption('guru-code-local');
  await page.getByLabel('What should change?').fill('In feature.js, change enabled to true and in draft.json change the version to 0.1.1 so the feature and its version are updated together.');
}

test('Guru readiness matrix shows blocked evidence and keeps Guru action disabled', async ({ page }) => {
  const root = await approveFixtureRoot(page);
  await openStudio(page, { roots: [root] });
  await expect(page.locator('#guruReadinessMatrix')).toHaveAttribute('data-status', 'blocked');
  await expect(page.locator('#guruReadinessMatrix')).toContainText('Checkpoint qualification');
  await expect(page.locator('#guruReadinessMatrix')).toContainText('guru/data/coding/model.json');
  await expect(page.locator('#guruCodeAction')).toBeDisabled();
});

test('Guru readiness matrix marks unavailable local evidence distinctly and keeps action disabled', async ({ page }) => {
  const root = await approveFixtureRoot(page);
  await openStudio(page, { roots: [root], guruReadiness: {
    schema: 'maataa-guru-readiness-v1', status: 'unavailable', action: { enabled: false, reason: 'Python runtime is unavailable.' },
    entries: [{ id: 'corpus_admission', label: 'Corpus and admission', status: 'unavailable', summary: 'Python runtime is unavailable; corpus preflight could not run.', blockers: ['Current corpus state is unknown.'], evidence: [{ path: 'guru/guru/corpus/cli.py', detail: 'Preflight command.' }] }],
  } });
  await expect(page.locator('#guruReadinessMatrix')).toHaveAttribute('data-status', 'unavailable');
  await expect(page.locator('#guruReadinessMatrix')).toContainText('Python runtime is unavailable');
  await expect(page.locator('#guruCodeAction')).toBeDisabled();
});

test('Guru readiness matrix identifies pending exact model pins as unverified and keeps action disabled', async ({ page }) => {
  const root = await approveFixtureRoot(page);
  await openStudio(page, { roots: [root], guruReadiness: {
    schema: 'maataa-guru-readiness-v1', status: 'blocked', action: { enabled: false, reason: 'Model and evaluator are unqualified.' },
    entries: [
      { id: 'student_model', label: 'Exact student model and tokenizer', status: 'unverified', summary: 'Candidate selected; exact artifact identity, recipe binding, rights review, or model intake is pending.', blockers: ['Exact tokenizer digest is missing.', 'Student-base intake review is not approved.', 'Student-base weight-use permission is not approved.'], evidence: [{ path: 'guru/experiments/recipes/qwen25_coder_15b_lora_sft.v1.json', detail: 'Draft pin.' }, { path: 'guru/data/coding/student-base-intake.json', detail: 'Optional owner-supplied local intake.' }] },
      { id: 'trainer_compatibility', label: 'Selected-model trainer compatibility', status: 'unverified', summary: 'Qwen2 LoRA scaffold exists; loader binding and exact-artifact compatibility are unverified.', blockers: ['Local-only model/tokenizer loader is not integrated.'], evidence: [{ path: 'guru/guru/qwen2_lora_engine.py', detail: 'Gated trainer mechanics.' }] },
      { id: 'evaluator', label: 'Isolated evaluator', status: 'blocked', summary: 'Evaluator qualification is missing.', blockers: ['Disposable evaluator is not qualified.'], evidence: [{ path: 'guru/experiments/recipes/qwen25_coder_15b_lora_sft.v1.json', detail: 'Evaluator gate.' }] },
    ],
  } });
  await expect(page.locator('#guruReadinessMatrix [data-status="unverified"]').filter({ hasText: 'Exact student model and tokenizer' })).toBeVisible();
  const studentRow = page.locator('#guruReadinessMatrix [data-status="unverified"]').filter({ hasText: 'Exact student model and tokenizer' });
  await expect(studentRow).toContainText('Student-base intake review is not approved');
  await expect(studentRow).toContainText('guru/data/coding/student-base-intake.json');
  await expect(page.locator('#guruReadinessMatrix [data-status="unverified"]').filter({ hasText: 'Selected-model trainer compatibility' })).toBeVisible();
  await expect(page.locator('#guruReadinessMatrix [data-status="blocked"]')).toContainText('Isolated evaluator');
  await expect(page.locator('#guruCodeAction')).toBeDisabled();
});

test('simulated absent student intake stays blocked and Guru action stays disabled', async ({ page }) => {
  const root = await approveFixtureRoot(page);
  await openStudio(page, { roots: [root], guruReadiness: {
    schema: 'maataa-guru-readiness-v1', status: 'blocked', action: { enabled: false, reason: 'Student-base intake is absent.' },
    entries: [{ id: 'student_model', label: 'Exact student model and tokenizer', status: 'unverified', summary: 'No owner-supplied student intake record exists.', blockers: ['Student-base intake is unavailable: required local record file is absent.'], evidence: [{ path: 'guru/data/coding/student-base-intake.json', detail: 'Optional owner-supplied local intake.' }] }],
  } });
  const studentRow = page.locator('#guruReadinessMatrix [data-status="unverified"]').filter({ hasText: 'Exact student model and tokenizer' });
  await expect(studentRow).toContainText('required local record file is absent');
  await expect(page.locator('#guruCodeAction')).toBeDisabled();
});

test('simulated mismatched student intake stays blocked and Guru action stays disabled', async ({ page }) => {
  const root = await approveFixtureRoot(page);
  await openStudio(page, { roots: [root], guruReadiness: {
    schema: 'maataa-guru-readiness-v1', status: 'blocked', action: { enabled: false, reason: 'Student-base intake does not match the selected recipe.' },
    entries: [{ id: 'student_model', label: 'Exact student model and tokenizer', status: 'unverified', summary: 'Intake identity does not match the selected student.', blockers: ['Intake model revision does not match the selected recipe.', 'Intake tokenizer digest does not match the selected recipe.'], evidence: [{ path: 'guru/data/coding/student-base-intake.json', detail: 'Simulated mismatch response; no intake was written.' }] }],
  } });
  const studentRow = page.locator('#guruReadinessMatrix [data-status="unverified"]').filter({ hasText: 'Exact student model and tokenizer' });
  await expect(studentRow).toContainText('Intake model revision does not match the selected recipe');
  await expect(studentRow).toContainText('Intake tokenizer digest does not match the selected recipe');
  await expect(page.locator('#guruCodeAction')).toBeDisabled();
});

test('Guru readiness matrix separates trainer environment blockers from selected-model compatibility', async ({ page }) => {
  const root = await approveFixtureRoot(page);
  await openStudio(page, { roots: [root], guruReadiness: {
    schema: 'maataa-guru-readiness-v1', status: 'blocked', action: { enabled: false, reason: 'Training environment and exact-model compatibility are not qualified.' },
    entries: [
      { id: 'trainer_environment', label: 'Trainer environment', status: 'blocked', summary: 'Python version mismatch: expected 3.12.4, found 3.12.1. All 37 locked package versions match.', blockers: ['Python version mismatch: expected 3.12.4, found 3.12.1.'], evidence: [{ path: 'guru/guru/training_stack_inspector.py', detail: 'Local-only trainer-stack preflight.' }] },
      { id: 'trainer_compatibility', label: 'Selected-model trainer compatibility', status: 'unverified', summary: 'Exact selected-model and tokenizer compatibility remains unverified.', blockers: ['Exact model and tokenizer artifacts have not been inspected.'], evidence: [{ path: 'guru/experiments/recipes/qwen25_coder_15b_lora_sft.v1.json', detail: 'Selected candidate recipe.' }] },
    ],
  } });
  const matrix = page.locator('#guruReadinessMatrix');
  await expect(matrix).toHaveAttribute('data-status', 'blocked');
  const environmentRow = matrix.locator('[data-status="blocked"]').filter({ hasText: 'Trainer environment' });
  await expect(environmentRow).toBeVisible();
  await expect(environmentRow).toContainText('expected 3.12.4, found 3.12.1');
  await expect(environmentRow).toContainText('All 37 locked package versions match');
  await expect(matrix.locator('[data-status="unverified"]').filter({ hasText: 'Selected-model trainer compatibility' })).toBeVisible();
  await expect(page.locator('#guruCodeAction')).toBeDisabled();
});

test('Coding Studio gives a clear empty state when no project is approved', async ({ page }) => {
  await openStudio(page);
  await expect(page.getByRole('heading', { name: 'Approve a project to begin' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Local Workspace' })).toBeVisible();
  await expect(page.locator('#studioCreateProposal')).toBeDisabled();
  await expect(page.getByText(/no trained Guru-Code checkpoint/i)).toBeVisible();
});

test('Coding Studio requires the approved project test-command allowlist', async ({ page }) => {
  const root = await approveFixtureRoot(page);
  await openStudio(page, { roots: [root] });

  await expect(page.getByRole('heading', { name: 'Test and refine in a private copy' })).toBeVisible();
  await expect(page.getByText('Test command approval required')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run tests and refine' })).toBeDisabled();
  await page.getByRole('button', { name: 'Review test command allowlist' }).click();
  await expect(page.getByRole('heading', { name: 'Local Workspace' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve repository command allowlist' })).toBeVisible();

  await page.request.delete(`http://127.0.0.1:8791/api/workspace/roots/${encodeURIComponent(root.id)}`, { headers: { Origin: 'http://127.0.0.1:8791' } });
});

test('Coding Studio starts, recovers, displays evidence for, and cancels a saved test loop', async ({ page }) => {
  const root = await approveFixtureRoot(page);
  const approvedRoot = { ...root, path: fixtureRoot, commandAllowlist: { repositoryPath: fixtureRoot, actions: ['test'] } };
  const flow = codingLoopFlow(root.id);
  await openStudio(page, { roots: [approvedRoot], loopFlow: flow });
  await page.getByLabel('Local coding model').selectOption('guru-code-local');
  await page.getByLabel('What should change?').fill('In feature.js, change enabled to true so the feature is enabled by default.');

  await page.getByRole('button', { name: 'Run tests and refine' }).click();
  await expect(page.locator('#studioLoopStatus')).toHaveAttribute('data-status', 'running');
  await expect(page.locator('#studioLoopStatus')).toContainText('2 tests passed');
  await expect(page.locator('#studioLoopStatus')).toContainText('Expected true but received false');
  expect(flow.starts).toBe(1);
  expect(fs.readFileSync(`${fixtureRoot}/feature.js`, 'utf8')).toContain('false');

  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    DB.models = [{ id: 'guru-code-local', name: 'Guru-Code local', runtime: 'ollama', digest: 'a'.repeat(64), details: { parameter_size: '7B' }, contextLength: 8192 }];
  });
  await page.locator('[data-view="codingstudio"]').click();
  await expect(page.locator('#studioLoopStatus')).toHaveAttribute('data-status', 'running');
  await expect(page.locator('#studioLoopStatus')).toContainText('loop-coding-studio-e2e');
  await expect(page.locator('#studioLoopStatus')).toContainText('Attempt 1');

  await page.getByRole('button', { name: 'Cancel test loop' }).click();
  await expect(page.locator('#studioLoopStatus')).toHaveAttribute('data-status', 'cancelled');
  await expect(page.locator('#studioLoopStatus')).toContainText('Cancelled.');
  expect(fs.readFileSync(`${fixtureRoot}/feature.js`, 'utf8')).toContain('false');
  expect(fs.readFileSync(`${fixtureRoot}/draft.json`, 'utf8')).toContain('0.1.0');

  await page.request.delete(`http://127.0.0.1:8791/api/workspace/roots/${encodeURIComponent(root.id)}`, { headers: { Origin: 'http://127.0.0.1:8791' } });
});

test('Coding Studio keeps a loop running until delayed cancellation is confirmed by polling', async ({ page }) => {
  const root = await approveFixtureRoot(page);
  const approvedRoot = { ...root, path: fixtureRoot, commandAllowlist: { repositoryPath: fixtureRoot, actions: ['test'] } };
  const flow = codingLoopFlow(root.id);
  flow.deferCancellation();
  await openStudio(page, { roots: [approvedRoot], loopFlow: flow });
  await page.getByLabel('Local coding model').selectOption('guru-code-local');
  await page.getByLabel('What should change?').fill('In feature.js, change enabled to true so the feature is enabled by default.');
  await page.getByRole('button', { name: 'Run tests and refine' }).click();
  await expect(page.locator('#studioLoopStatus')).toHaveAttribute('data-status', 'running');

  await page.getByRole('button', { name: 'Cancel test loop' }).click();
  await expect(page.locator('#studioLoopStatus')).toHaveAttribute('data-status', 'running');
  await expect(page.getByRole('button', { name: 'Cancel test loop' })).toBeVisible();
  await expect(page.locator('#studioLoopStatus')).toHaveAttribute('data-status', 'cancelled', { timeout: 5000 });
  await expect(page.locator('#studioLoopStatus')).toContainText('Cancelled.');
  expect(fs.readFileSync(`${fixtureRoot}/feature.js`, 'utf8')).toContain('false');
  expect(fs.readFileSync(`${fixtureRoot}/draft.json`, 'utf8')).toContain('0.1.0');

  await page.request.delete(`http://127.0.0.1:8791/api/workspace/roots/${encodeURIComponent(root.id)}`, { headers: { Origin: 'http://127.0.0.1:8791' } });
});

test('passing test evidence opens only a reviewable batch and leaves approval separate', async ({ page }) => {
  const root = await approveFixtureRoot(page);
  const response = await page.request.post('http://127.0.0.1:8791/api/workspace/change-batches', {
    headers: { Origin: 'http://127.0.0.1:8791' },
    data: { rootId: root.id, summary: 'Create a test-verified fixture file', changes: [{ operation: 'create', relativePath: 'tested-output.txt', content: 'verified\n' }] },
  });
  expect(response.ok()).toBeTruthy();
  const batch = await response.json();
  const flow = codingLoopFlow(root.id);
  flow.seedReady(batch.id);
  const approvedRoot = { ...root, path: fixtureRoot, commandAllowlist: { repositoryPath: fixtureRoot, actions: ['test'] } };
  await openStudio(page, { roots: [approvedRoot], loopFlow: flow });

  await expect(page.locator('#studioLoopStatus')).toHaveAttribute('data-status', 'ready');
  await expect(page.locator('#studioLoopStatus')).toContainText('Tests passed · batch ready for review');
  await page.locator('#studioLoopStatus details summary').last().click();
  await expect(page.getByLabel('Coding Studio test output')).toContainText('2 tests passed after the change');
  await page.getByRole('button', { name: 'Review tested changes in Local Workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Local Workspace' })).toBeVisible();
  await expect(page.getByLabel('Combined batch diff')).toContainText('+verified');
  await expect(page.getByRole('button', { name: 'Validate entire batch' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve exact batch' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Apply atomically' })).toHaveCount(0);
  expect(fs.existsSync(`${fixtureRoot}/tested-output.txt`)).toBe(false);

  await page.request.delete(`http://127.0.0.1:8791/api/workspace/roots/${encodeURIComponent(root.id)}`, { headers: { Origin: 'http://127.0.0.1:8791' } });
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

test('agent proposal waits for human review, then needs validation and separate approval before any write', async ({ page }) => {
  const root = await approveFixtureRoot(page);
  const flow = codingAgentFlow(page, root.id);
  await openStudio(page, { roots: [root], agentFlow: flow });
  await fillCodingTask(page);
  await page.getByRole('button', { name: 'Check readiness' }).click();
  await expect(page.getByRole('button', { name: 'Ask agent for proposal' })).toBeEnabled();
  const batchCountBefore = (await rootBatches(page, root.id)).length;
  await page.getByRole('button', { name: 'Ask agent for proposal' }).click();
  await expect(page.getByRole('article').filter({ has: page.getByText('Agent proposal awaiting your review') })).toBeVisible();
  await expect(page.getByText('No project file has been written by the agent.')).toBeVisible();
  await expect(page.locator('#studioAgentTask .coding-studio-code').nth(0)).toContainText('const enabled = false;');
  await expect(page.locator('#studioAgentTask .coding-studio-code').nth(1)).toContainText('const enabled = true;');
  expect(fs.readFileSync(`${fixtureRoot}/feature.js`, 'utf8')).toContain('false');
  expect(await rootBatches(page, root.id)).toHaveLength(batchCountBefore);
  await expect(page.getByRole('button', { name: 'Apply atomically' })).toHaveCount(0);

  await page.getByLabel('Review note').fill('The proposal targets only the requested feature flag.');
  await page.getByRole('button', { name: 'Accept proposal for validation' }).click();
  await expect(page.getByText('Proposal accepted · validation still required')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review exact batch in Local Workspace' })).toBeVisible();
  expect(fs.readFileSync(`${fixtureRoot}/feature.js`, 'utf8')).toContain('false');
  await page.getByRole('button', { name: 'Review exact batch in Local Workspace' }).click();
  await expect(page.getByLabel('Combined batch diff')).toContainText('+const enabled = true;');
  await page.getByRole('button', { name: 'Validate entire batch' }).click();
  await expect(page.getByRole('button', { name: 'Approve exact batch' })).toBeVisible();
  expect(fs.readFileSync(`${fixtureRoot}/feature.js`, 'utf8')).toContain('false');
  await page.getByRole('button', { name: 'Approve exact batch' }).click();
  await expect(page.getByRole('button', { name: 'Apply atomically' })).toBeVisible();
  expect(fs.readFileSync(`${fixtureRoot}/feature.js`, 'utf8')).toContain('false');
  await page.getByRole('button', { name: 'Apply atomically' }).click();
  await expect(page.getByText('Applied 2 change(s).')).toBeVisible();
  expect(fs.readFileSync(`${fixtureRoot}/feature.js`, 'utf8')).toContain('true');
  expect(fs.readFileSync(`${fixtureRoot}/draft.json`, 'utf8')).toContain('0.1.1');
  await page.getByRole('button', { name: 'Roll back batch' }).click();
  await expect(page.getByText('Rolled back — every file restored to its pre-batch state.')).toBeVisible();
  expect(fs.readFileSync(`${fixtureRoot}/feature.js`, 'utf8')).toContain('false');
  await page.request.delete(`http://127.0.0.1:8791/api/workspace/roots/${encodeURIComponent(root.id)}`, { headers: { Origin: 'http://127.0.0.1:8791' } });
});

test('agent revision, retry, cancellation and rejection never create or write a batch', async ({ page }) => {
  const root = await approveFixtureRoot(page);
  const batchCountBefore = (await rootBatches(page, root.id)).length;
  const flow = codingAgentFlow(page, root.id);
  await openStudio(page, { roots: [root], agentFlow: flow });
  await fillCodingTask(page);
  await page.getByRole('button', { name: 'Check readiness' }).click();
  await page.getByRole('button', { name: 'Ask agent for proposal' }).click();
  await expect(page.locator('#studioAgentTask')).toHaveAttribute('data-state', 'awaiting_result_review');
  await page.getByLabel('Review note').fill('Please include the matching configuration change.');
  await page.getByRole('button', { name: 'Request a revision' }).click();
  await expect(page.getByText('Revision requested')).toBeVisible();
  await page.getByLabel('Revision instructions').fill('Update the feature flag and its fixture version together.');
  await page.getByRole('button', { name: 'Ask agent to revise' }).click();
  await expect(page.locator('#studioAgentTask')).toHaveAttribute('data-state', 'running');
  await page.getByRole('button', { name: 'Cancel task' }).click();
  await expect(page.locator('#studioAgentTask')).toHaveAttribute('data-state', 'cancelled');
  await page.getByRole('button', { name: 'Ask agent for proposal' }).click();
  await expect(page.locator('#studioAgentTask')).toHaveAttribute('data-state', 'awaiting_result_review');
  await page.getByLabel('Review note').fill('The proposal does not match the requested scope.');
  await page.getByRole('button', { name: 'Reject proposal' }).click();
  await expect(page.locator('#studioAgentTask')).toHaveAttribute('data-state', 'rejected');
  expect(fs.readFileSync(`${fixtureRoot}/feature.js`, 'utf8')).toContain('false');
  expect(await rootBatches(page, root.id)).toHaveLength(batchCountBefore);
  await page.request.delete(`http://127.0.0.1:8791/api/workspace/roots/${encodeURIComponent(root.id)}`, { headers: { Origin: 'http://127.0.0.1:8791' } });
});

test('failed agent tasks can be retried only with fresh bounded feedback', async ({ page }) => {
  const root = await approveFixtureRoot(page);
  const flow = codingAgentFlow(page, root.id);
  flow.seedFailed();
  await openStudio(page, { roots: [root], agentFlow: flow });
  await expect(page.locator('#studioAgentTask')).toHaveAttribute('data-state', 'failed');
  await expect(page.locator('#studioAgentTask')).toContainText('failed');
  await expect(page.getByRole('button', { name: 'Retry failed task' })).toBeVisible();
  const feedback = page.getByLabel('Fresh retry feedback');
  await expect(feedback).toHaveAttribute('maxlength', '1500');
  await page.getByRole('button', { name: 'Retry failed task' }).click();
  await expect(page.locator('#studioAgentError')).toContainText('Describe the correction before retrying.');
  await feedback.fill('Use the requested project scope and explain the correction.');
  await page.getByRole('button', { name: 'Retry failed task' }).click();
  await expect(page.locator('#studioAgentTask')).toHaveAttribute('data-state', 'running');
  await page.request.delete(`http://127.0.0.1:8791/api/workspace/roots/${encodeURIComponent(root.id)}`, { headers: { Origin: 'http://127.0.0.1:8791' } });
});

test('failed-task retry stays unavailable while the runtime is halted', async ({ page }) => {
  const root = await approveFixtureRoot(page);
  const flow = codingAgentFlow(page, root.id);
  flow.seedFailed();
  flow.controls.runtime_halted = true;
  await openStudio(page, { roots: [root], agentFlow: flow });
  await expect(page.locator('#studioAgentTask')).toHaveAttribute('data-state', 'failed');
  await expect(page.locator('#studioAgentTask').getByRole('button', { name: 'Retry failed task' })).toHaveCount(0);
  await expect(page.locator('#studioAgentTask').getByLabel('Fresh retry feedback')).toHaveCount(0);
  await expect(page.locator('#codingstudioView')).toContainText('Agent runtime is halted.');
  await page.request.delete(`http://127.0.0.1:8791/api/workspace/roots/${encodeURIComponent(root.id)}`, { headers: { Origin: 'http://127.0.0.1:8791' } });
});

test('failed-task retry stays unavailable when task controls are missing', async ({ page }) => {
  const root = await approveFixtureRoot(page);
  const flow = codingAgentFlow(page, root.id);
  flow.seedFailed();
  flow.omitTaskControls();
  await openStudio(page, { roots: [root], agentFlow: flow });
  await expect(page.locator('#studioAgentTask')).toHaveAttribute('data-state', 'failed');
  await expect(page.locator('#studioAgentTask').getByRole('button', { name: 'Retry failed task' })).toHaveCount(0);
  await expect(page.locator('#studioAgentTask').getByLabel('Fresh retry feedback')).toHaveCount(0);
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
  await expect(page.locator('#studioError')).toContainText('project changed after readiness was checked');
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

test.describe('Guru-Code Playwright demo recording', () => {
  test('records the simulated proposal, human review, apply and rollback flow', async ({ page }, testInfo) => {
    const root = await approveFixtureRoot(page);
    const flow = codingAgentFlow(page, root.id);
    const video = page.video();
    const videoPath = process.env.GURU_CODE_DEMO_VIDEO || testInfo.outputPath('guru-code-playwright-demo.webm');
    fs.mkdirSync(require('node:path').dirname(videoPath), { recursive: true });

    try {
      await openStudio(page, {
        roots: [root],
        agentFlow: flow,
        modelLabel: 'Guru-Code demo (simulated)',
      });
      await page.evaluate(() => {
        const banner = document.createElement('div');
        banner.setAttribute('role', 'note');
        banner.textContent = 'PLAYWRIGHT DEMO · SIMULATED MODEL OUTPUT · NO GURU-CODE CHECKPOINT';
        Object.assign(banner.style, {
          position: 'sticky', top: '0', zIndex: '99999', padding: '9px 12px',
          background: '#713d17', color: '#fff7e8', textAlign: 'center',
          font: '600 12px/1.4 system-ui, sans-serif', letterSpacing: '.04em',
        });
        document.body.prepend(banner);
      });
      await page.waitForTimeout(900);

      await fillCodingTask(page);
      await page.locator('#studioModel').selectOption('guru-code-local');
      await page.locator('#studioModel option[value="guru-code-local"]').evaluate(option => { option.textContent = 'Guru-Code demo (simulated)'; });
      await page.getByRole('button', { name: 'Check readiness' }).click();
      await expect(page.locator('#studioReadiness')).toContainText('Ready for a code proposal');
      await page.waitForTimeout(1100);

      await page.getByRole('button', { name: 'Ask agent for proposal' }).click();
      await expect(page.getByText('Agent proposal awaiting your review')).toBeVisible();
      await expect(page.getByText('No project file has been written by the agent.')).toBeVisible();
      await page.waitForTimeout(1400);

      await page.getByLabel('Review note').fill('The simulated proposal is limited to the requested fixture change.');
      await page.getByRole('button', { name: 'Accept proposal for validation' }).click();
      await expect(page.getByText('Proposal accepted · validation still required')).toBeVisible();
      await page.waitForTimeout(900);
      await page.getByRole('button', { name: 'Review exact batch in Local Workspace' }).click();
      await expect(page.getByLabel('Combined batch diff')).toContainText('+const enabled = true;');
      await page.waitForTimeout(1100);

      await page.getByRole('button', { name: 'Validate entire batch' }).click();
      await expect(page.getByRole('button', { name: 'Approve exact batch' })).toBeVisible();
      await page.waitForTimeout(800);
      await page.getByRole('button', { name: 'Approve exact batch' }).click();
      await expect(page.getByRole('button', { name: 'Apply atomically' })).toBeVisible();
      await page.waitForTimeout(800);
      await page.getByRole('button', { name: 'Apply atomically' }).click();
      await expect(page.getByText('Applied 2 change(s).')).toBeVisible();
      await page.waitForTimeout(1000);
      await page.getByRole('button', { name: 'Roll back batch' }).click();
      await expect(page.getByText('Rolled back — every file restored to its pre-batch state.')).toBeVisible();
      expect(fs.readFileSync(`${fixtureRoot}/feature.js`, 'utf8')).toContain('false');
      await page.waitForTimeout(1400);
    } finally {
      await page.request.delete(`http://127.0.0.1:8791/api/workspace/roots/${encodeURIComponent(root.id)}`, { headers: { Origin: 'http://127.0.0.1:8791' } }).catch(() => {});
      await page.close();
      if (video) {
        await video.saveAs(videoPath);
        await testInfo.attach('Guru-Code simulated Playwright demo', { path: videoPath, contentType: 'video/webm' });
      }
    }
  });
});
