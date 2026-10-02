const { test, expect } = require('@playwright/test');

test.describe('NOVA Console interactions', () => {
  test('keeps the composer visible and sends a message in a new session', async ({ page }) => {
    await page.goto('/');
    await page.locator('#newSessionBtn').click();
    const composer = page.locator('#composer');
    await expect(composer).toBeVisible();
    await expect(composer).toBeInViewport();

    await composer.fill('Write a concise local test response.');
    await page.locator('#sendBtn').click();
    await expect(page.locator('.msg.user .bubble').last()).toContainText('Write a concise local test response.');
    await expect(composer).toBeVisible();
    await expect(composer).toBeInViewport();
  });

  test('long conversations scroll inside the message list and keep the composer on screen', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle'); // let first-run seeding finish before changing the store
    const base = new URL(page.url()).origin;
    const messages = Array.from({ length: 40 }, (_, i) => ({ id: 'long' + i, role: i % 2 ? 'assistant' : 'user', content: `Message ${i} ` + 'lorem ipsum dolor sit amet '.repeat(i % 2 ? 12 : 2), createdAt: new Date().toISOString() }));
    const put = await page.request.put(base + '/api/store/sessions', { headers: { Origin: base }, data: { id: 'sess_e2e_long', title: 'E2E long chat', modelId: 'llama3:latest', pinned: false, archived: false, tags: [], createdAt: new Date().toISOString(), updatedAt: new Date(Date.now() + 1e9).toISOString(), messages } });
    expect(put.ok()).toBeTruthy();
    await page.setViewportSize({ width: 1440, height: 800 });
    await page.goto('/');
    await page.locator('.sess-item', { hasText: 'E2E long chat' }).click();
    const layout = await page.evaluate(() => {
      const list = document.getElementById('msgList'), composer = document.querySelector('.composer').getBoundingClientRect();
      return { scrollable: list.scrollHeight > list.clientHeight + 10, composerOnScreen: composer.bottom <= innerHeight && composer.top >= 0, atBottom: list.scrollHeight - list.scrollTop - list.clientHeight < 5 };
    });
    expect(layout).toEqual({ scrollable: true, composerOnScreen: true, atBottom: true });
    const kept = await page.evaluate(() => { const list = document.getElementById('msgList'); list.scrollTop = 0; list.dispatchEvent(new Event('scroll')); renderConvo(); return list.scrollTop; });
    expect(kept).toBe(0);
    await expect(page.getByRole('button', { name: 'Jump to latest message' })).toBeVisible();
    await page.getByRole('button', { name: 'Jump to latest message' }).click();
    await expect(page.getByRole('button', { name: 'Jump to latest message' })).toBeHidden();
  });

  test('top bar shows the open session\'s model and the context budget uses its real window', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle'); // let first-run seeding finish before changing the store
    const base = new URL(page.url()).origin;
    const headers = { Origin: base };
    // ctxMax in raw tokens is how older syncs stored an Ollama model.
    expect((await page.request.put(base + '/api/store/models', { headers, data: { id: 'llama3:latest', name: 'llama3:latest', runtime: 'ollama', runtimeKind: 'local', quant: 'Q4_0', ctx: null, ctxMax: 8192 } })).ok()).toBeTruthy();
    expect((await page.request.put(base + '/api/store/sessions', { headers, data: { id: 'sess_e2e_model', title: 'E2E model pill', modelId: 'llama3:latest', pinned: false, archived: false, tags: [], preferences: { retrieval: false }, createdAt: new Date().toISOString(), updatedAt: new Date(Date.now() + 2e9).toISOString(), messages: [{ id: 'mm1', role: 'user', content: 'hello', createdAt: new Date().toISOString() }] } })).ok()).toBeTruthy();
    await page.reload();
    await page.locator('.sess-item', { hasText: 'E2E model pill' }).click();
    await expect(page.locator('#modelStatusPill')).toContainText('llama3:latest');
    await expect(page.locator('#railModelLine')).toContainText('llama3:latest');
    const inspector = page.locator('#inspectorPane');
    await expect(inspector).toContainText('/ 8,192');
    await expect(inspector).not.toContainText('Infinity');
  });

  test('media view uploads an image, keeps it in the library, and attaches it to chat', async ({ page }) => {
    await page.goto('/');
    await page.locator('.sess-item').first().click();
    await page.locator('.nav-item[data-media-tab="image"]').click();
    await page.getByRole('tab', { name: 'Image' }).click();
    await expect(page.getByRole('heading', { name: 'Generate an image' })).toBeVisible();
    await expect(page.locator('.media-helpers')).toContainText('How it works');
    await page.getByRole('tab', { name: 'Transcribe' }).click();
    await expect(page.getByRole('heading', { name: 'Upload and transcribe' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Generate an image' })).toBeHidden();
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
    await page.getByLabel('Upload images, audio or video').setInputFiles({ name: 'location-scout.png', mimeType: 'image/png', buffer: png });
    await expect(page.locator('article strong', { hasText: 'location-scout.png' })).toBeVisible();
    await page.locator('.media-item', { hasText: 'location-scout.png' }).locator('summary', { hasText: 'Actions' }).click();
    await page.getByRole('menuitem', { name: 'Attach to chat' }).first().click();
    await expect(page.locator('#contextChips')).toContainText('location-scout.png');
  });

  test('media view turns a library image into a shot for image to video', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.locator('.nav-item[data-media-tab="image"]').click();
    await page.getByRole('tab', { name: 'Video' }).click();
    await expect(page.getByRole('heading', { name: 'Animate stills' })).toBeVisible();
    await page.getByRole('tab', { name: 'Library' }).click();
    await expect(page.locator('#libraryPanel')).toContainText('Set by NOVA_LIBRARY_DIR');
    await page.getByRole('tab', { name: 'Audio' }).click();
    await expect(page.getByRole('heading', { name: 'Voice, sound effects, music' })).toBeVisible();
    await page.getByLabel('Audio type').selectOption('music');
    await expect(page.getByLabel('Lyrics', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Image' }).click();
    await expect(page.getByLabel('Start from an image')).toBeVisible();
    await page.getByRole('tab', { name: 'Library' }).click();
    await expect(page.locator('#libraryPanel code')).toHaveText(/nova-e2e-.*\/library$/);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
    await page.getByLabel('Upload images, audio or video').setInputFiles({ name: 'storyboard-01.png', mimeType: 'image/png', buffer: png });
    await expect(page.locator('article strong', { hasText: 'storyboard-01.png' })).toBeVisible();
    await page.getByRole('button', { name: 'Animate', exact: true }).first().click();
    await expect(page.locator('.video-shot')).toHaveCount(1);
    await expect(page.getByLabel('Camera move for shot 1')).toHaveValue('push-in');
    await expect(page.getByRole('tab', { name: 'Video' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'Render clip' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove shot 1' }).click();
    await expect(page.locator('.video-shot')).toHaveCount(0);
    await page.getByLabel('Upload stills to animate').setInputFiles({ name: 'still-2.png', mimeType: 'image/png', buffer: png });
    await expect(page.locator('.video-shot')).toHaveCount(1);
    await page.getByRole('tab', { name: 'Library' }).click();
    await page.locator('.media-item', { hasText: 'storyboard-01.png' }).locator('summary', { hasText: 'Actions' }).click();
    await page.getByRole('menuitem', { name: 'Filters', exact: true }).first().click();
    await expect(page.getByRole('tab', { name: 'Edit' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('Look')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Apply' })).toBeVisible();
  });

  test('every list gets search, filter and sort; views have help; prompts have presets', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.locator('[data-view="skills"]').click();
    const search = page.getByLabel('Search this list').first();
    await expect(search).toBeVisible();
    await search.fill('shot list');
    await expect(page.locator('.skill-card:visible')).toHaveCount(1);
    await expect(page.locator('.list-count').first()).toContainText('1 of');
    await page.getByRole('button', { name: 'What can I do here?' }).click();
    await expect(page.locator('.help-box')).toContainText('Sandboxed tools');
    await expect(page.locator('#helpDrawer')).toBeVisible();
    await page.locator('.nav-item[data-media-tab="image"]').click();
    await expect(page.locator('#helpDrawer')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Image' }).click();
    await page.locator('#genPrompt').fill('Marine Drive at dusk');
    await page.locator('.helper-chip', { hasText: 'golden hour' }).click();
    await expect(page.locator('#genPrompt')).toHaveValue('Marine Drive at dusk, golden hour');
    await page.getByRole('tab', { name: 'Audio' }).click();
    await page.getByLabel('Audio type').selectOption('music');
    await expect(page.getByLabel('Song idea')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Write lyrics' })).toBeVisible();
    await expect(page.locator('.helper-chip', { hasText: 'tabla' })).toBeVisible();
  });

  test('pre-production skills are installed and ask for a brief', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-view="skills"]').click();
    for (const name of ['Treatment Writer', 'Shot List', 'Call Sheet']) await expect(page.getByText(name, { exact: true })).toBeVisible();
    await expect(page.locator('.skill-text-input[data-id="skl_shotlist"]')).toBeVisible();
    await expect(page.getByLabel('Translate into')).toHaveValue('Hindi');
    await expect(page.locator('.skill-text-input[data-id="skl_pptx"]')).toBeVisible();
    await expect(page.getByText('Still on the simulated path')).toHaveCount(0);
  });

  test('every sidebar view opens without a script error', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const views = await page.locator('.nav-item[data-view]').evaluateAll(items => items.map(item => item.dataset.view + (item.dataset.mediaTab ? ':' + item.dataset.mediaTab : '')));
    expect(views.length).toBeGreaterThan(15);
    for (let i = 0; i < views.length; i++) {
      await page.locator('.nav-item[data-view]').nth(i).click();
      await page.waitForTimeout(150);
      expect(errors, `opening ${views[i]}`).toEqual([]);
    }
  });

  test('creates a session and navigates between Console, Knowledge, Runtime, and Provider Browser', async ({ page }) => {
    await page.goto('/');
    await page.locator('#newSessionBtn').click();
    await expect(page.locator('#convoTitle')).toHaveText('New local session');

    await page.locator('[data-view="knowledge"]').click();
    await expect(page.locator('#knowledgeView')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Knowledge' })).toBeVisible();

    await page.locator('[data-view="runtime"]').click();
    await expect(page.locator('#runtimeView')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Runtime' })).toBeVisible();

    await page.locator('[data-view="browser"]').click();
    await expect(page.locator('#browserView')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Provider Browser' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open Codex' })).toBeVisible();
  });

  test('persists theme and interface language choices', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-view="settings"]').click();
    await page.getByLabel('Theme').selectOption('dawn');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dawn');

    await page.getByLabel('Interface language').selectOption('hi');
    await expect(page.locator('[data-view="console"] .rail-text')).toHaveText('कंसोल');
    await expect(page.locator('html')).toHaveAttribute('lang', 'hi');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dawn');
    await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
  });

  test('keeps demo mode disabled until the user explicitly opts in', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-view="settings"]').click();
    const demoMode = page.getByLabel('Demo mode');
    await expect(demoMode).not.toHaveClass(/\bon\b/);
    await demoMode.click();
    await expect(demoMode).toHaveClass(/\bon\b/);
    await page.reload();
    await page.locator('[data-view="settings"]').click();
    await expect(page.getByLabel('Demo mode')).toHaveClass(/\bon\b/);
  });

  test('approves and scans an exact local workspace root', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-view="workspace"]').click();
    await expect(page.getByRole('heading', { name: 'Local Workspace' })).toBeVisible();
    await page.getByLabel('Local folder path').fill('/Users/vesahe/Documents/Repos/brahmini/nova-console');
    await page.getByLabel('Folder label').fill('NOVA Console');
    await page.getByRole('button', { name: 'Approve root' }).click();
    await expect(page.getByLabel('Approved local root')).toContainText('NOVA Console');
    await page.getByRole('button', { name: 'Scan folder' }).click();
    await expect(page.getByText('Files observed')).toBeVisible();
    await expect(page.getByText('Read-only').last()).toBeVisible();
    await page.getByRole('button', { name: 'Generate structured report' }).click();
    await expect(page.getByText('Code health', { exact: true }).last()).toBeVisible();
    await expect(page.getByText('Security signals', { exact: true }).last()).toBeVisible();
    await expect(page.getByText('Repository changes', { exact: true }).last()).toBeVisible();
  });

  test('turns a workspace conversation into a reviewable plan before execution', async ({ page }) => {
    await page.goto('/');
    await page.locator('#newSessionBtn').click();
    await page.locator('#composer').fill('review NOVA Console project');
    await page.locator('#sendBtn').click();
    await expect(page.getByRole('button', { name: 'Review scan plan' })).toBeVisible();
    await expect(page.locator('.msg.assistant .bubble').last()).toContainText('Permissions: read-only');
    await page.getByRole('button', { name: 'Review scan plan' }).click();
    await expect(page.getByText('Conversation scan plan')).toBeVisible();
    await expect(page.getByText('No writes to local folders; Maataa plan/report store only')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run plan' })).toBeVisible();
  });

  test('drafts a patch and checks it in an isolated workspace copy', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-view="workspace"]').click();
    await page.getByLabel('Local folder path').fill('/private/tmp/nova-e2e-workspace');
    await page.getByLabel('Folder label').fill('Writable test copy');
    await page.getByRole('button', { name: 'Approve root' }).click();
    await expect(page.getByRole('status')).toContainText('Local root approved.');

    await page.getByLabel('Scanned relative file').fill('draft.json');
    await page.getByLabel('Exact text to replace').fill('"version":"0.1.0"');
    await page.getByLabel('Replacement').fill('"version":"0.1.1-draft"');
    await page.getByLabel('Impact explanation').fill('Demonstrates a reviewable version change without modifying the original workspace.');
    await page.getByRole('button', { name: 'Create patch proposal' }).click();

    await expect(page.getByLabel('Proposed unified diff')).toContainText('-{"version":"0.1.0"}');
    await expect(page.getByLabel('Proposed unified diff')).toContainText('+{"version":"0.1.1-draft"}');
    await expect(page.getByText('Original write').last()).toBeVisible();
    await expect(page.getByText('Disabled').last()).toBeVisible();

    await page.getByRole('button', { name: 'Run safe checks in workspace copy' }).click();
    await expect(page.getByText('checks-passed').last()).toBeVisible();
    await expect(page.getByText('JSON parse').last()).toBeVisible();
    await page.getByRole('button', { name: 'Approve this write batch' }).click();
    await expect(page.getByText('Approved for this batch')).toBeVisible();
    await page.getByRole('button', { name: 'Write approved batch' }).click();
    await expect(page.getByText('applied').last()).toBeVisible();
    await expect(page.getByText('Rollback backup')).toBeVisible();
    await expect(page.getByText('Before SHA-256')).toBeVisible();
    await expect(page.getByText('After SHA-256')).toBeVisible();
  });

  test('requires a repository command allowlist and runs bounded git status', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-view="workspace"]').click();
    await page.getByLabel('Local folder path').fill('/Users/vesahe/Documents/Repos/brahmini');
    await page.getByLabel('Folder label').fill('Brahmini repository');
    await page.getByRole('button', { name: 'Approve root' }).click();
    await expect(page.getByRole('status')).toContainText('Local root approved.');
    await page.locator('#workspaceCommandChoices input').evaluateAll(inputs => inputs.forEach(input => { input.checked = input.value === 'git-status'; }));
    await page.getByRole('button', { name: 'Approve repository command allowlist' }).click();
    await expect(page.getByRole('button', { name: 'git-status' })).toBeVisible();
    await page.getByRole('button', { name: 'git-status' }).click();
    await expect(page.getByText('passed').last()).toBeVisible();
    // `git status --short --branch` always starts with the branch header; file lines depend on the tree.
    await expect(page.getByLabel('Command output')).toContainText('## ');
    await expect(page.getByText('256.0 KB')).toBeVisible();
  });

  test('shows Git evidence and requires exact staged-file review for a commit draft', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-view="workspace"]').click();
    await page.getByLabel('Local folder path').fill('/private/tmp/nova-e2e-workspace');
    await page.getByLabel('Folder label').fill('Git review fixture');
    await page.getByRole('button', { name: 'Approve root' }).click();
    await expect(page.getByRole('status')).toContainText('Local root approved.');
    await expect(page.getByText('Exact changed files')).toBeVisible();
    await expect(page.getByLabel('Working diff')).toContainText('0.1.1-draft');
    await page.locator('#workspaceGitFiles input[value="draft.json"]').check();
    await page.getByLabel('Draft commit message').fill('Draft reviewed version update');
    await page.getByRole('button', { name: 'Stage selected files and create draft' }).click();
    await expect(page.getByText('awaiting-review').last()).toBeVisible();
    await expect(page.getByLabel('Reviewed staged diff')).toContainText('draft.json');
    await page.getByRole('button', { name: 'I reviewed these exact staged files and diff' }).click();
    await expect(page.getByRole('button', { name: 'Create commit' })).toBeVisible();
  });

  test('shows the permission registry and creates an encrypted local backup', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-view="workspace"]').click();
    await expect(page.getByRole('button', { name: 'Choose folder…' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Permissions, encrypted audit, backup and restore' })).toBeVisible();
    await page.getByLabel('Backup label').fill('E2E security backup');
    await page.getByRole('button', { name: 'Create encrypted backup' }).click();
    await expect(page.getByText('E2E security backup')).toBeVisible();
    await expect(page.getByText('backup.created')).toBeVisible();
  });

  test('reviews and applies an ordered multi-file batch with rollback evidence', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-view="workspace"]').click();
    await page.getByLabel('Local folder path').fill('/private/tmp/nova-e2e-workspace');
    await page.getByLabel('Folder label').fill('Batch fixture');
    await page.getByRole('button', { name: 'Approve root' }).click();
    await expect(page.getByRole('status')).toContainText('Local root approved.'); // the view re-renders after approval; fill the form after that
    await page.getByLabel('Multi-file batch changes').fill(JSON.stringify([
      {relativePath:'batch-main.js',find:'false',replacement:'true',dependsOn:['batch-config.json']},
      {relativePath:'batch-config.json',find:'false',replacement:'true'},
    ]));
    await page.getByLabel('Batch summary').fill('Enable feature after configuration');
    await page.getByRole('button', { name: 'Create multi-file batch' }).click();
    await expect(page.getByText('batch-config.json → batch-main.js')).toBeVisible();
    await expect(page.getByLabel('Combined batch diff')).toContainText('+{"enabled":true}');
    await page.getByRole('button', { name: 'Validate entire batch' }).click();
    await page.getByRole('button', { name: 'Approve exact batch' }).click();
    await page.getByRole('button', { name: 'Apply atomically' }).click();
    await expect(page.getByText('Applied 2 change(s).')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Roll back batch' })).toBeVisible();
    await expect(page.getByText('Rollback', {exact:true})).toBeVisible();
  });

  test('queues, evaluates, and approves a truthful purpose-specific tensor in Neuron Factory', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-view="neurons"]').click();
    await expect(page.getByRole('heading', { name: 'Neuron Factory' })).toBeVisible();
    await expect(page.getByText('Maataa does not claim to create physical qubits.')).toBeVisible();
    await page.getByLabel('Neuron name').fill('AND purpose tensor');
    await page.getByLabel('Neuron purpose').fill('Detect when both bounded input signals are active.');
    await page.getByRole('button', { name: 'Create blueprint' }).click();
    await expect(page.getByText('AND purpose tensor')).toBeVisible();
    await page.getByRole('button', { name: 'Queue training' }).click();
    await expect(page.getByText(/Background job (queued|running)/)).toBeVisible();
    await expect(page.getByText('awaiting-evaluation')).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'Evaluate quality' }).click();
    await expect(page.getByText('awaiting-approval')).toBeVisible();
    await page.getByRole('button', { name: 'Approve artifact' }).click();
    await expect(page.getByText('dense-tensor-backprop-v1')).toBeVisible();
    await expect(page.locator('.runtime-inline', { hasText: 'approved' })).toBeVisible();
  });

  test('reads the Ashtadhyayi and trains a sutra neuron that agrees with its sutra', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-view="panini"]').click();
    await expect(page.getByRole('heading', { name: 'Ashtadhyayi' })).toBeVisible();
    await expect(page.locator('.panini-sutra').first()).toContainText('वृद्धिरादैच्');
    await page.getByLabel('Find sutras').fill('1.1.101');
    await page.getByRole('button', { name: 'Find' }).click();
    await expect(page.getByText('There is no sutra 1.1.101. Pada 1.1 has 75 sutras.')).toBeVisible();
    await page.getByLabel('Find sutras').fill('iko yaṇaci');
    await page.getByRole('button', { name: 'Find' }).click();
    await expect(page.locator('.panini-sutra')).toHaveCount(1);
    await expect(page.locator('.panini-sutra')).toContainText('इको यणचि');
    await page.getByRole('tab', { name: 'Dhatupatha' }).click();
    await page.getByLabel('Find a root').fill('भू');
    await page.getByRole('button', { name: 'Find' }).click();
    await expect(page.getByText('सत्तायाम्')).toBeVisible();
    await page.getByRole('tab', { name: 'Sutras' }).click();
    await page.getByLabel('Find sutras').fill('6.1.77');
    await page.getByRole('button', { name: 'Find' }).click();
    await page.getByRole('button', { name: 'Train a neuron' }).click();
    await expect(page.getByRole('heading', { name: 'Neuron Factory' })).toBeVisible();
    const card = page.locator('article', { hasText: 'यण् sandhi neuron (6.1.77)' });
    await card.getByRole('button', { name: 'Queue training' }).click();
    await expect(card.getByRole('button', { name: 'Evaluate quality' })).toBeVisible({ timeout: 8000 });
    await card.getByRole('button', { name: 'Evaluate quality' }).click();
    await expect(page.getByText('Agrees with the sutra on 169 of 169 vowel pairs')).toBeVisible();
    await page.locator('article', { hasText: 'यण् sandhi neuron (6.1.77)' }).getByRole('button', { name: 'Ask the neuron' }).click();
    await expect(page.locator('.sutra-try-out')).toContainText('sutra 6.1.77: य् ✓');
  });

  test('Maataa AAI derives a word with a sutra at every step, checks forms and converts scripts', async ({ page, request }) => {
    const status = await (await request.get('/api/aai')).json();
    await page.goto('/');
    await page.locator('[data-view="aai"]').click();
    await expect(page.getByRole('heading', { name: 'Maataa AAI' })).toBeVisible();
    await expect(page.getByText('nothing is called correct unless the rules confirm it')).toBeVisible();
    await page.getByLabel('Text to check').fill('6.1.87 इको यणचि');
    await page.getByRole('button', { name: 'Check citations' }).click();
    await expect(page.getByText('quoted words belong to another sutra')).toBeVisible();
    await page.locator('[data-view="lipi"]').click();
    await expect(page.locator('#lipiView')).toContainText('guruḥ śiṣyaṃ jñānaṃ dadāti');
    test.skip(!status.engine.installed, 'derivation engine not installed on this computer');
    await page.locator('[data-view="derivation"]').click();
    await page.getByRole('button', { name: 'Show all forms' }).click();
    await page.locator('.aai-cell', { hasText: 'भवति' }).click();
    await expect(page.getByText('Derived by rule')).toBeVisible();
    await expect(page.locator('.aai-steps')).toContainText('एचोऽयवायावः');
    await page.getByLabel('Form to check').fill('भवाति');
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.getByText('Not derived')).toBeVisible();
    // R1: both results came back sealed as signed evidence records.
    await expect(page.getByText(/Sealed as evidence #\d+/)).toHaveCount(2);
    await page.locator('[data-view="aai"]').click();
    const evRow = page.locator('#aaiView tr', { hasText: 'Derive भू (01.0001)' }).first();
    await expect(evRow).toContainText('Derived');
    await evRow.getByRole('button', { name: 'Replay' }).click();
    await expect(page.locator('#aaiView')).toContainText('Run again, the rules give exactly the same result.');
    await page.getByRole('button', { name: 'Verify the chain' }).click();
    await expect(page.getByText(/Chain intact · \d+ sealed records/)).toBeVisible();
    // An exported file checks out on its own, and an edited one does not (same-origin fetch, as the page does).
    const [clean, edited] = await page.evaluate(async () => {
      const list = await (await fetch('/api/aai/evidence?limit=5')).json();
      const bundle = await (await fetch(`/api/aai/evidence/${list[0].id}/bundle`)).json();
      const check = async b => (await (await fetch('/api/aai/evidence/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json()).ok;
      const ok = await check(bundle);
      bundle.result.claim = 'भवति';
      return [ok, await check(bundle)];
    });
    expect(clean).toBe(true);
    expect(edited).toBe(false);
  });
});
