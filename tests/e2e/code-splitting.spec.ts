/*
 * Each dashboard page loads its own code (#662), against the built
 * dashboard the npm package ships.
 *
 *   - every page and every view of `/` renders, with no console error;
 *   - a page whose code is slow to arrive shows the loading status, then
 *     the page;
 *   - a page whose code cannot arrive says so and offers a reload;
 *   - hashed assets are cached as immutable, index.html is not, and a
 *     missing asset is a 404 rather than the app's HTML.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

function consoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

/** The page's own content: something in <main> other than the loading status or an error. */
const pageContent = (p: Page) => p.locator('main > :not([data-route-loading]):not([data-error-boundary])').first();

/** A path, and a landmark that only renders once that page's own code has run. */
const PAGES: Array<[string, (page: Page) => ReturnType<Page['locator']>]> = [
  ['/', (p) => p.getByRole('heading', { level: 2, name: 'What failed' })],
  ['/?view=health', (p) => p.getByRole('radio', { name: '30d' })],
  ['/?view=drift', (p) => p.getByRole('radio', { name: '7d' })],
  ['/?view=stream', (p) => p.getByRole('heading', { level: 2, name: 'Live now' })],
  ['/moments', (p) => p.getByLabel('Order moments')],
  ['/rules', pageContent],
  ['/audit', pageContent],
  ['/traces', pageContent],
  ['/evals', pageContent],
  ['/runs', pageContent],
];

test.describe('pages load on demand', () => {
  test('every page and every view renders from its own chunk, without console errors', async ({ page }) => {
    const errors = consoleErrors(page);
    for (const [path, landmark] of PAGES) {
      await page.goto(path);
      await expect(landmark(page), path).toBeVisible();
      await expect(page.locator('[data-route-loading]')).toHaveCount(0);
    }
    const blocking = errors.filter((e) => !/400|429/.test(e));
    expect(blocking, blocking.join(' | ')).toEqual([]);
  });

  test('the first load does not carry the pages: a page chunk is fetched when its page is shown', async ({ page }) => {
    const scripts: string[] = [];
    page.on('request', (r) => {
      if (r.resourceType() === 'script') scripts.push(new URL(r.url()).pathname);
    });
    await page.goto('/traces');
    await expect(page.locator('h1').first()).toBeVisible();
    // The traces page's own chunk was requested, separately from the entry.
    expect(scripts.some((s) => /\/assets\/TraceListPage-[^/]+\.js$/.test(s)), scripts.join(', ')).toBe(true);
    expect(scripts.some((s) => /\/assets\/index-[^/]+\.js$/.test(s))).toBe(true);
  });

  test('a page whose code is slow to arrive shows the loading status, then the page', async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(/\/assets\/RulesPage-[^/]+\.js$/, async (route) => {
      await held;
      await route.continue();
    });
    await page.goto('/rules');
    const status = page.getByRole('status').filter({ hasText: 'Loading page…' });
    await expect(status).toBeVisible();
    await expect(status).toHaveAttribute('aria-live', 'polite');
    // The shell is usable while the page waits.
    await expect(page.locator('h1').first()).toBeVisible();
    release();
    await expect(status).toHaveCount(0);
    await expect(pageContent(page)).toBeVisible();
  });

  test('a page whose code cannot arrive says so and offers a reload', async ({ page }) => {
    await page.route(/\/assets\/AuditPage-[^/]+\.js$/, (route) => route.abort());
    await page.goto('/audit');
    const alert = page.getByRole('alert').filter({ hasText: "This page's code could not be loaded." });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole('button', { name: 'Reload the dashboard' })).toBeVisible();
    // With the chunk reachable again, the offered reload recovers the page.
    await page.unroute(/\/assets\/AuditPage-[^/]+\.js$/);
    await alert.getByRole('button', { name: 'Reload the dashboard' }).click();
    await expect(alert).toHaveCount(0);
    await expect(pageContent(page)).toBeVisible();
  });

  test('hashed assets are cached as immutable; index.html is revalidated; a missing asset is a 404', async ({ page, request }) => {
    const chunk = new Promise<string>((resolve) => {
      page.on('response', (r) => {
        if (/\/assets\/[^/]+\.js$/.test(new URL(r.url()).pathname)) resolve(new URL(r.url()).pathname);
      });
    });
    await page.goto('/');
    const assetPath = await chunk;

    const asset = await request.get(assetPath);
    expect(asset.status()).toBe(200);
    expect(asset.headers()['cache-control']).toContain('immutable');
    expect(asset.headers()['cache-control']).toContain('max-age=31536000');

    const index = await request.get('/');
    expect(index.headers()['cache-control'] ?? '').not.toContain('immutable');

    const missing = await request.get('/assets/NoSuchPage-00000000.js');
    expect(missing.status()).toBe(404);
    const body = await missing.text();
    expect(body).not.toContain('<!doctype html>');
    expect(body).not.toMatch(/dist[\\/]+dashboard/);
  });
});
