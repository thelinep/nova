const { test, expect } = require('@playwright/test');

test('Stop aborts an outstanding conversational code-planning request', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#composer')).toBeVisible();
  await page.waitForFunction(() => typeof activeSession === 'function' && activeSession()); // first-run seeding picks the session a moment after load
  await page.route('**/api/workspace/code-plan', () => {});
  const requested = page.waitForRequest('**/api/workspace/code-plan');
  await page.evaluate(() => {
    workspaceSelectedRootId = 'cancellation-fixture';
    DB.models.push({ id: 'planner-fixture', name: 'planner-fixture', runtime: 'ollama' });
    ollamaStatus.reachable = true;
    const session = activeSession();
    session.modelId = 'planner-fixture';
    window.pendingCodePlan = draftCodePlanFromConversation(session, 'change the code file');
  });
  await requested;
  const aborted = page.waitForEvent('requestfailed', { predicate: request => request.url().endsWith('/api/workspace/code-plan') });
  await page.evaluate(() => requestCancelGeneration());
  await aborted;
  await page.evaluate(() => window.pendingCodePlan);
  await expect(page.locator('.msg.assistant .bubble').last()).toContainText('could not create a safe code draft');
  expect(await page.evaluate(() => PIPELINE.abortController)).toBeNull();
});
