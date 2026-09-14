const { test, expect } = require('@playwright/test');

test.describe('NOVA Console interactions', () => {
  test('keeps the composer visible and sends a message in a new session', async ({ page }) => {
    await page.goto('/');
    const composer = page.locator('#composer');
    await expect(composer).toBeVisible();
    await expect(composer).toBeInViewport();

    await composer.fill('Write a concise local test response.');
    await page.locator('#sendBtn').click();
    await expect(page.locator('.msg.user .bubble').last()).toContainText('Write a concise local test response.');
    await expect(composer).toBeVisible();
    await expect(composer).toBeInViewport();
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
    await expect(page.getByText('No writes to local folders; NOVA plan/report store only')).toBeVisible();
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
    await expect(page.getByLabel('Command output')).toContainText('nova-console');
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
});
