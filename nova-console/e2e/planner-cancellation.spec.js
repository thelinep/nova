const { test, expect } = require('@playwright/test');

test('Stop aborts an outstanding conversational code-planning request', async ({ page }) => {
  await page.goto('/');
  await page.locator('#newSessionBtn').click();
  await expect(page.locator('#composer')).toBeVisible();
  await page.route('**/api/workspace/code-plan', () => {});
  const requested = page.waitForRequest('**/api/workspace/code-plan');
  await page.evaluate(() => {
    workspaceSelectedRootId = 'cancellation-fixture';
    DB.models.push({ id: 'planner-fixture', name: 'planner-fixture', runtime: 'ollama' });
    ollamaStatus.reachable = true;
    const session = activeSession();
    session.modelId = 'planner-fixture';
    window.pendingCodePlan = draftCodePlanFromConversation(session, 'change the code file', true);
  });
  await requested;
  const aborted = page.waitForEvent('requestfailed', { predicate: request => request.url().endsWith('/api/workspace/code-plan') });
  await page.evaluate(() => requestCancelGeneration());
  await aborted;
  await page.evaluate(() => window.pendingCodePlan);
  await expect(page.locator('.msg.assistant .bubble').last()).toContainText('could not create a safe code draft');
  expect(await page.evaluate(() => PIPELINE.abortController)).toBeNull();
});

test('conversation previews qualification and scope before explicit draft generation', async ({ page }) => {
  await page.goto('/');
  await page.locator('#newSessionBtn').click();
  await expect(page.locator('#composer')).toBeVisible();
  let generated = 0;
  await page.route('**/api/workspace/code-plan/preview', route => route.fulfill({json:{
    ready:true, plannedFiles:['feature.js'], selectedModel:{name:'llama3:latest',digest:'a'.repeat(64)},
    qualification:{passes:3,trials:3,qualified:true}, repositoryScope:{omittedFiles:['large.txt']},
    expectedChecks:['Exact replacement check']
  }}));
  await page.route('**/api/workspace/code-plan', route => {
    generated++;
    return route.fulfill({json:{id:'preview-draft',type:'workspace-change',planner:{modelId:'llama3:latest'}}});
  });
  await page.evaluate(async () => {
    workspaceSelectedRootId='preview-fixture';
    DB.models.push({id:'requested-small',name:'requested-small',runtime:'ollama'});
    ollamaStatus.reachable=true;
    activeSession().modelId='requested-small';
    await draftCodePlanFromConversation(activeSession(),'change the code file feature.js to enable it');
  });
  await expect(page.locator('.msg.assistant .bubble').last()).toContainText('large.txt');
  await expect(page.locator('.msg.assistant .bubble').last()).toContainText('llama3:latest');
  expect(generated).toBe(0);
  await page.getByRole('button',{name:'Generate code draft',exact:true}).click();
  await expect(page.locator('.msg.assistant .bubble').last()).toContainText('using llama3:latest');
  expect(generated).toBe(1);
});

test('clarification preview creates no generation request', async ({ page }) => {
  await page.goto('/');
  await page.locator('#newSessionBtn').click();
  await expect(page.locator('#composer')).toBeVisible();
  await page.route('**/api/workspace/code-plan/preview', route => route.fulfill({json:{ready:false,clarification:'Please provide an exact target filename.',plannedFiles:[]}}));
  await page.evaluate(async () => {
    workspaceSelectedRootId='preview-fixture';
    DB.models.push({id:'preview-model',name:'preview-model',runtime:'ollama'});
    ollamaStatus.reachable=true;activeSession().modelId='preview-model';
    await draftCodePlanFromConversation(activeSession(),'fix the code project');
  });
  await expect(page.locator('.msg.assistant .bubble').last()).toContainText('Please provide an exact target filename');
  await expect(page.getByRole('button',{name:'Generate code draft',exact:true})).toHaveCount(0);
});
