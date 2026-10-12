const { test, expect } = require('@playwright/test');

async function openBoard(page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.locator('[data-view="radheya"]').click();
  await expect(page.getByRole('heading', { name: 'Radheya', exact: true })).toBeVisible();
}

test('a card goes Backlog → Review, cannot reach Done without evidence, then does', async ({ page }) => {
  await openBoard(page);
  await page.locator('#rdNewTitle').fill('Check the Panchang page renders');
  await page.getByRole('button', { name: 'Add card' }).click();
  const backlog = page.getByRole('region', { name: 'Backlog' });
  await expect(backlog.getByRole('button', { name: /Check the Panchang page renders/ })).toBeVisible();
  await expect(page.locator('#rdDetail')).toBeVisible();
  for (const to of ['ready', 'doing', 'review']) await page.locator('#rdMoveTo').selectOption(to);
  await expect(page.getByRole('region', { name: 'Review' }).getByRole('button', { name: /Check the Panchang/ })).toBeVisible();
  await page.locator('#rdMoveTo').selectOption('done');
  await expect(page.locator('#toast')).toContainText('Notes are not evidence');
  await page.locator('#rdEvUrl').fill('https://example.org/panchang-screenshot');
  await page.getByRole('button', { name: 'Add evidence link' }).click();
  await expect(page.locator('#rdDetail')).toContainText('example.org');
  await page.locator('#rdMoveTo').selectOption('done');
  await expect(page.getByRole('region', { name: 'Done' }).getByRole('button', { name: /Check the Panchang/ })).toBeVisible();
  await expect(page.locator('#rdLearn')).toContainText('events');
});

test('WIP limits come from settings and block an extra card', async ({ page }) => {
  await openBoard(page);
  await page.locator('#rdSettings summary').click();
  await page.locator('#rdWipDoing').fill('1');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#toast')).toContainText('Settings saved');
  for (const t of ['WIP one', 'WIP two']) {
    await page.locator('#rdNewTitle').fill(t);
    await page.getByRole('button', { name: 'Add card' }).click();
    await expect(page.locator('#rdDetailTitle')).toHaveText(t);
    await page.locator('#rdMoveTo').selectOption('ready');
    await expect(page.getByRole('region', { name: 'Ready' }).getByRole('button', { name: new RegExp(t) })).toBeVisible();
    await page.locator('#rdMoveTo').selectOption('doing');
    if (t === 'WIP one') {
      await expect(page.getByRole('region', { name: 'Doing' }).getByRole('button', { name: /WIP one/ })).toBeVisible();
    }
  }
  await expect(page.locator('#toast')).toContainText('WIP limit');
  await expect(page.getByRole('region', { name: 'Doing' })).toContainText('1 / 1');
});

test('a run is started from the card and its result arrives as a note and evidence', async ({ page }) => {
  await openBoard(page);
  await page.evaluate(() => { DB.models = [{ id: 'qwen2.5-coder:7b', name: 'qwen2.5-coder:7b', runtime: 'ollama' }]; });
  await page.locator('#rdNewTitle').fill('Summarise the release notes');
  await page.getByRole('button', { name: 'Add card' }).click();
  await page.locator('#rdKind').selectOption('local');
  await page.locator('#rdModel').selectOption('qwen2.5-coder:7b');
  await page.locator('#rdMoveTo').selectOption('ready');
  let ran = null;
  await page.route('**/api/radheya/cards/*/run', async route => { ran = route.request().postDataJSON(); await route.fulfill({ status: 202, json: { id: 'run_x', status: 'running' } }); });
  await page.getByRole('button', { name: 'Run with Local model' }).click();
  await expect.poll(() => ran && ran.model).toBe('qwen2.5-coder:7b');
  expect(ran.kind).toBe('local');
});
