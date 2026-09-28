const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test.describe('Conversation tools', () => {
  test('+ menu adds a folder by path; the chip shows it reading then ready; Inspector lists it', async ({ page }) => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-e2e-src-'));
    fs.writeFileSync(path.join(proj, 'brief.md'), '# Brief\nFriday at Marine Drive.');
    try {
      await page.goto('/');
      await page.locator('#newSessionBtn').click();
      await page.locator('#addBtn').click();
      await expect(page.locator('#addMenu')).toBeVisible();
      await expect(page.locator('#addMenu [data-add]')).toHaveCount(5);
      await page.locator('#addMenu [data-add="url"]').click();
      await expect(page.locator('#addForm')).toBeVisible();
      await expect(page.locator('#addFormNote')).toContainText('network access');
      await page.keyboard.press('Escape');
      // Browser mode on Linux has no native picker: the typed-path form appears.
      await page.evaluate(() => openAddForm('folder'));
      await page.locator('#addFormInput').fill(proj);
      await page.locator('#addFormGo').click();
      const chip = page.locator('.src-chip').first();
      await expect(chip).toContainText(path.basename(proj));
      await expect(page.locator('.src-chip.src-ready')).toHaveCount(1, { timeout: 10000 });
      await page.evaluate(() => { inspectorTab = 'files'; renderInspTabs(); renderInspBody(); });
      await expect(page.locator('#inspBody')).toContainText(path.basename(proj));
      await page.locator('.chip-remove-src').first().click();
      await expect(page.locator('.src-chip')).toHaveCount(0);
    } finally { fs.rmSync(proj, { recursive: true, force: true }); }
  });

  test('replies render Markdown safely, with steps, actions and follow-ups', async ({ page }) => {
    await page.goto('/');
    await page.locator('#newSessionBtn').click();
    await page.evaluate(() => {
      const s = activeSession();
      s.messages.push({ id: 'u1', role: 'user', content: 'plan?', createdAt: nowIso() });
      s.messages.push({ id: 'a1', role: 'assistant', content: '**Friday** shoot\n\n- wide\n- close\n\n<img src=x onerror=alert(1)>', createdAt: nowIso(), steps: [{ id: 's1', label: 'Reading brief.md', status: 'done', detail: '2 passages' }, { id: 's2', label: 'Run a command', status: 'running', waiting: true, approvalId: 'apr_x', detail: 'ls' }], approvals: { apr_x: { id: 'apr_x', title: 'Run a command', detail: 'ls', risk: 'run' } }, followups: ['Make a call sheet'], stats: { tokens: 10, seconds: 1.2 } });
      renderConvo();
    });
    const bubble = page.locator('.msg.assistant .bubble.md').last();
    await expect(bubble.locator('strong')).toHaveText('Friday');
    await expect(bubble.locator('li')).toHaveCount(2);
    await expect(bubble.locator('img')).toHaveCount(0);
    await expect(bubble).toContainText('<img src=x');
    await expect(page.locator('.msg-steps')).toHaveAttribute('open', '');
    await expect(page.locator('.approval-card')).toContainText('Run a command');
    await expect(page.locator('.followup-chip')).toHaveText('Make a call sheet');
    await page.locator('.msg.assistant .msg-react[data-r="up"]').click();
    await expect(page.locator('.msg.assistant .msg-react[data-r="up"]')).toHaveClass(/on/);
    await page.locator('.msg.user .msg-edit').click();
    await expect(page.locator('#msgEditBox')).toHaveValue('plan?');
    await page.locator('#msgEditCancel').click();
  });

  test('Computer and Voice toggles, the mic button and the Activity drawer', async ({ page }) => {
    await page.goto('/');
    await page.locator('#newSessionBtn').click();
    await page.locator('#computerToggleBtn').click();
    await expect(page.locator('#computerToggleBtn')).toHaveClass(/on/);
    await page.locator('#speakToggleBtn').click();
    await expect(page.locator('#speakToggleBtn')).toHaveClass(/on/);
    await expect(page.locator('#micBtn')).toBeVisible();
    await page.locator('#activityBtn').click();
    await expect(page.locator('#activityDrawer')).toContainText('Activity');
    await page.locator('#activityClose').click();
    await expect(page.locator('#activityDrawer')).toHaveCount(0);
  });

  test('Settings: computer switches and memory notes', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => showView('settings'));
    await expect(page.locator('#setCompEnabled')).toBeVisible();
    await page.locator('#memoryNew').fill('I shoot on a Sony FX3');
    await page.locator('#memoryAdd').click();
    await expect(page.locator('#memoryList')).toContainText('Sony FX3');
    await page.locator('.mem-del').first().click();
    await expect(page.locator('#memoryList')).not.toContainText('Sony FX3');
  });

  test('composer controls fit a phone-width window', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.waitForFunction(() => typeof DB !== 'undefined' && DB.models.length > 0);
    await page.evaluate(() => createSession());
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    for (const id of ['#sendBtn', '#micBtn', '#addBtn', '#computerToggleBtn']) await expect(page.locator(id)).toBeInViewport();
  });

  test('typing "add folder <path>" or "+ > Add folder" does it instead of sending a message', async ({ page }) => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-e2e-typed-'));
    fs.writeFileSync(path.join(proj, 'a.md'), '# A');
    try {
      await page.goto('/');
      await page.locator('#newSessionBtn').click();
      await page.locator('#composer').fill('add folder ' + proj);
      await page.keyboard.press('Enter');
      await expect(page.locator('.src-chip')).toContainText(path.basename(proj));
      await expect(page.locator('.msg.user')).toHaveCount(0);
      await page.locator('#composer').fill('+ > Add folder');
      await page.keyboard.press('Enter');
      await expect(page.locator('#addForm')).toBeVisible(); // no native picker in this test browser
      await expect(page.locator('.msg.user')).toHaveCount(0);
    } finally { fs.rmSync(proj, { recursive: true, force: true }); }
  });
});
