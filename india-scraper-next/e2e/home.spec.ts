import { expect, test, type Page } from '@playwright/test';

const refinedResult = {
  id: 1,
  category: 'plumbers',
  district_id: 1,
  district_name: 'Pune',
  business_name: 'Best Plumbing',
  contact_person: 'Raj',
  phone: '9876543210',
  address: '123 MG Road',
  website: 'https://example.com',
  last_updated: '2026-01-01T00:00:00Z',
};

async function mockResults(page: Page, options: { refined?: unknown[]; history?: unknown[] } = {}) {
  await page.route('**/api/refined-results**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(options.refined ?? []) }),
  );
  await page.route('**/api/history-results**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(options.history ?? []) }),
  );
}

test.describe('India Business Scraper browser journeys', () => {
  test('renders the initial refined-data state', async ({ page }) => {
    await mockResults(page);
    await page.goto('/');

    await expect(page.getByRole('heading', { name: /India Business Scraper/i })).toBeVisible();
    await expect(page.getByPlaceholder(/plumbers, dentists/i)).toBeVisible();
    await expect(page.getByTestId('results-table')).toContainText('No data found');
    await expect(page.getByText('Showing latest 0 records')).toBeVisible();
  });

  test('renders refined records, fallbacks, and safe external links', async ({ page }) => {
    await mockResults(page, {
      refined: [refinedResult, { ...refinedResult, id: 2, business_name: 'Solo Shop', contact_person: null, phone: null, address: null, website: null }],
    });
    await page.goto('/');

    await expect(page.getByTestId('results-table')).toContainText('Best Plumbing');
    await expect(page.getByRole('link', { name: 'Link' })).toHaveAttribute('href', 'https://example.com');
    await expect(page.getByRole('link', { name: 'Link' })).toHaveAttribute('target', '_blank');
    await expect(page.getByTestId('results-table')).toContainText('Solo Shop');
    await expect(page.getByText('Showing latest 2 records')).toBeVisible();
  });

  test('switches to history data and updates the date heading', async ({ page }) => {
    await mockResults(page, { history: [{ ...refinedResult, scraped_at: '2026-02-01T00:00:00Z' }] });
    await page.goto('/');
    await page.getByRole('button', { name: 'History (All)' }).click();

    await expect(page.getByRole('columnheader', { name: 'Scraped At' })).toBeVisible();
    await expect(page.getByTestId('results-table')).toContainText('Best Plumbing');
  });

  test('requires a category before a scrape can start', async ({ page }) => {
    await mockResults(page);
    await page.goto('/');

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByTestId('start-button').click();
    await expect(page.getByText('No data found')).toBeVisible();
  });

  test('starts a job, polls to completion, then refreshes results', async ({ page }) => {
    let jobCompleted = false;
    await page.route('**/api/refined-results**', (route) => {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(jobCompleted ? [refinedResult] : []) });
    });
    await page.route('**/api/start-scrape', async (route) => {
      expect(route.request().method()).toBe('POST');
      expect(route.request().postDataJSON()).toEqual({ category: 'plumbers', district: '' });
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jobId: 'job-1', total: 2 }) });
    });
    await page.route('**/api/job/job-1', (route) => {
      jobCompleted = true;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jobId: 'job-1', total: 2, completed: 2, status: 'completed' }) });
    });
    await page.goto('/');
    await page.getByTestId('category-input').fill('plumbers');
    await page.getByTestId('start-button').click();

    await expect(page.getByText('Progress: 0 / 2')).toBeVisible();
    await expect(page.getByText('completed', { exact: true })).toBeVisible({ timeout: 6_000 });
    await expect(page.getByTestId('results-table')).toContainText('Best Plumbing');
  });

  test('surfaces an API start failure and returns the button to its ready state', async ({ page }) => {
    await mockResults(page);
    await page.route('**/api/start-scrape', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ error: 'No districts found' }) }),
    );
    await page.goto('/');
    await page.getByTestId('category-input').fill('plumbers');

    const dialog = page.waitForEvent('dialog');
    await page.getByTestId('start-button').click();
    const errorDialog = await dialog;
    expect(errorDialog.message()).toContain('No districts found');
    await errorDialog.accept();
    await expect(page.getByTestId('start-button')).toHaveText('Start Scraping');
  });
});
