/*
 * The states a reader can land in, each on a server started
 * for the purpose:
 *
 *   - an EMPTY database: every page says so in its own words and invents
 *     no number; the first-run hints and the demo command are on the
 *     landing page; the tour is one palette command away;
 *   - an API KEY: the sign-in page, then the dashboard on the key; the
 *     `?key=` link signs in and strips the key from the address bar; a
 *     wrong key is refused on the page.
 */
import { NAV_LABELS } from '../../dashboard/src/components/layout/navLabels.js';
import { test, expect } from '@playwright/test';
import { startServer, type SpawnedServer } from './_server.js';

test.describe('an empty database — the first run', () => {
  let server: SpawnedServer;
  test.beforeAll(async () => {
    server = await startServer({ prefix: 'iris-e2e-empty-' });
  });
  test.afterAll(async () => {
    await server.stop();
  });

  test('the landing page says nothing has run, names the demo command and the first-run hints; no page invents a number', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(`${server.baseUrl}/`);
    await expect(page.locator('h1')).toHaveText(NAV_LABELS.failures);
    await expect(page.getByRole('heading', { name: 'Nothing has run yet' })).toBeVisible();
    await expect(page.locator('[data-first-run-hints]')).toBeVisible();
    await expect(page.getByText('npx @iris-eval/mcp-server --demo')).toBeVisible();
    // No recurring-issues table on an empty store.
    await expect(page.locator('[data-issues]')).toHaveCount(0);

    await page.goto(`${server.baseUrl}/?view=health`);
    await expect(page.getByRole('heading', { level: 2, name: 'Headline' })).toBeVisible();

    await page.goto(`${server.baseUrl}/runs`);
    await expect(page.locator('h1')).toHaveText(NAV_LABELS.runs);
    await expect(page.locator('[data-run-link]')).toHaveCount(0);

    // The roster still lists every shipped rule; the labels panel says there is nothing yet.
    await page.goto(`${server.baseUrl}/rules`);
    await expect(page.locator('[data-roster="true"]')).toBeVisible();
    await expect(page.locator('[data-local-precision-panel="true"]')).toBeVisible();
    await expect(page.locator('[data-label-summary]')).toHaveText('0 labels on 0 rules · in force on 0');
    await expect(page.locator('[data-estimated-prior]')).toHaveCount(0);

    expect(errors, `page errors on the empty database: ${errors.join(' | ')}`).toEqual([]);
  });

  test('the tour is one palette command away', async ({ page }) => {
    await page.goto(`${server.baseUrl}/`);
    // The shortcut is bound once the shell has rendered; press it after the title is up.
    await expect(page.locator('h1')).toHaveText(NAV_LABELS.failures);
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog');
    await expect(palette).toBeVisible();
    await page.keyboard.type('tour');
    // The command's own title — the same words the landing page's hint uses.
    await expect(palette.getByRole('option', { name: /Onboarding tour/i })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
  });
});

test.describe('api-key sign-in', () => {
  const KEY = 'e2e-secret-key-0014';
  let server: SpawnedServer;
  test.beforeAll(async () => {
    server = await startServer({ prefix: 'iris-e2e-keyed-', args: ['--api-key', KEY] });
  });
  test.afterAll(async () => {
    await server.stop();
  });

  test('without a key the sign-in page; with the key, the dashboard on a session; a wrong key is refused on the page', async ({ page }) => {
    await page.goto(`${server.baseUrl}/`);
    await expect(page.getByRole('heading', { name: 'Iris dashboard' })).toBeVisible();
    await expect(page.getByText('This dashboard is protected by an API key.')).toBeVisible();

    await page.getByLabel('API key').fill('not-the-key');
    await page.getByRole('button', { name: 'Open dashboard' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Iris dashboard' })).toBeVisible();

    await page.getByLabel('API key').fill(KEY);
    await page.getByRole('button', { name: 'Open dashboard' }).click();
    await expect(page.locator('h1')).toHaveText(NAV_LABELS.failures);
    await expect(page.locator('header [data-status]')).toHaveAttribute('data-status', 'live');

    // The session holds across a navigation and a reload.
    await page.goto(`${server.baseUrl}/rules`);
    await expect(page.locator('h1')).toHaveText(NAV_LABELS.rules);
    await page.reload();
    await expect(page.locator('h1')).toHaveText(NAV_LABELS.rules);
  });

  test('a ?key= link signs the browser in and removes the key from the address bar', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${server.baseUrl}/runs?key=${KEY}`);
      await expect(page.locator('h1')).toHaveText(NAV_LABELS.runs);
      expect(page.url()).not.toContain(KEY);
      expect(new URL(page.url()).pathname).toBe('/runs');
    } finally {
      await context.close();
    }
  });
});
