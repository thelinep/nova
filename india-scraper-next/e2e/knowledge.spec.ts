import { expect, test } from '@playwright/test';

test.describe('Universal Knowledge Collector', () => {
  test('collects pasted text and displays the returned local source', async ({ page }) => {
    let sources = [{ id: 1, kind: 'text', url: null, title: 'Existing note', content: 'Already saved knowledge', content_type: 'text/plain', collected_at: '2026-01-01T00:00:00Z' }];
    await page.route('**/api/knowledge/sources', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(sources) }));
    await page.route('**/api/knowledge/patterns', (route) => route.fulfill({ contentType: 'application/json', body: '[]' }));
    await page.route('**/api/knowledge/collect', async (route) => {
      expect(route.request().postDataJSON()).toEqual({ type: 'text', title: 'Research note', content: 'A durable local note.' });
      sources = [{ id: 2, kind: 'text', url: null, title: 'Research note', content: 'A durable local note.', content_type: 'text/plain', collected_at: '2026-01-02T00:00:00Z' }, ...sources];
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ collected: 1, failed: [] }) });
    });
    await page.goto('/knowledge');
    await expect(page.getByTestId('knowledge-sources')).toContainText('Existing note');

    await page.getByRole('button', { name: 'Paste text' }).click();
    await page.getByTestId('knowledge-title').fill('Research note');
    await page.getByTestId('knowledge-content').fill('A durable local note.');
    await page.getByTestId('collect-submit').click();

    await expect(page.getByRole('status')).toHaveText('Collected 1 source.');
    await expect(page.getByTestId('knowledge-sources')).toContainText('Research note');
  });

  test('exposes URL-list and reusable numbered-pattern collection tools', async ({ page }) => {
    await page.route('**/api/knowledge/sources', (route) => route.fulfill({ contentType: 'application/json', body: '[]' }));
    await page.route('**/api/knowledge/patterns', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 1, label: 'Archive', pattern: 'https://example.org/{n}', created_at: '2026-01-01T00:00:00Z' }]) }));
    await page.goto('/knowledge');

    await page.getByRole('button', { name: 'URL list' }).click();
    await expect(page.getByTestId('knowledge-urls')).toBeVisible();
    await page.getByRole('button', { name: 'URL pattern' }).click();
    await expect(page.getByTestId('knowledge-pattern')).toBeVisible();
    await expect(page.getByText(/Private-network URLs/i)).toBeVisible();
    await expect(page.getByTestId('knowledge-patterns')).toContainText('https://example.org/{n}');
  });
});
