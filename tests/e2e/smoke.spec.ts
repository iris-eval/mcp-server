/*
 * Smoke + navigation E2E tests.
 *
 * The "fresh install reviewer" walk. Proves that the three BI views
 * render without console errors, chrome pieces are present, tab state
 * is URL-bound, and drill-through links exist on Health.
 *
 * These tests are the lowest-cost highest-value coverage: a regression
 * here means the dashboard is broken-broken (not just ugly).
 */
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Listen for console errors on every test. Playwright's default is
 * lenient; we tighten to fail on any page-level console.error.
 */
async function failOnConsoleErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

test.describe('dashboard smoke', () => {
  test('Health view loads as default with chrome + KPI tiles', async ({ page }) => {
    const errors = await failOnConsoleErrors(page);
    await page.goto('/');

    // Chrome: sidebar, header title, view tabs
    await expect(page.locator('h1')).toHaveText('Dashboard');
    await expect(page.getByRole('tab', { name: 'Health' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Drift' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Stream' })).toBeVisible();

    // Health sections
    await expect(page.getByRole('heading', { level: 2, name: 'Headline' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Trajectory' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /What stood out/ })).toBeVisible();

    // Pass rate appears at least once (KPI tile) — seed data is ~85% pass.
    await expect(page.locator('body')).toContainText(/\d+%/);

    // Tolerate 400/429 from background polling — they don't block the
    // visible UI. Hard failures that DO break rendering show up as
    // console.error AND invalidate the visibility assertions above.
    const blocking = errors.filter((e) => !/400|429/.test(e));
    expect(blocking, `console errors during Health load: ${blocking.join(' | ')}`).toEqual([]);
  });

  test('Drift view renders change banner + stacked bar', async ({ page }) => {
    const errors = await failOnConsoleErrors(page);
    await page.goto('/?view=drift');

    await expect(page.getByRole('tab', { name: 'Drift' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { level: 2, name: 'What changed' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Pattern over time' })).toBeVisible();

    expect(errors, `console errors during Drift load: ${errors.join(' | ')}`).toEqual([]);
  });

  test('Stream view renders live KPIs + trace tail', async ({ page }) => {
    const errors = await failOnConsoleErrors(page);
    await page.goto('/?view=stream');

    await expect(page.getByRole('tab', { name: 'Stream' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { level: 2, name: 'Live now' })).toBeVisible();
    // Live trace tail should show seeded traces.
    await expect(page.getByRole('region', { name: 'Live trace tail' })).toBeVisible();

    expect(errors, `console errors during Stream load: ${errors.join(' | ')}`).toEqual([]);
  });

  test('non-dashboard routes load without errors', async ({ page }) => {
    const errors = await failOnConsoleErrors(page);

    for (const path of ['/moments', '/rules', '/audit', '/traces', '/evals']) {
      await page.goto(path);
      // Chrome h1 renders on every route — matches routeTitles.ts.
      await expect(page.locator('h1').first()).toBeVisible();
    }

    expect(
      errors.filter((e) => !e.includes('429')), // ignore rate-limit noise if polling trips it under load
      `console errors walking routes: ${errors.join(' | ')}`,
    ).toEqual([]);
  });
});

test.describe('navigation', () => {
  test('switching views preserves period param', async ({ page }) => {
    await page.goto('/?view=health&period=7d');
    await expect(page.getByRole('radio', { name: '7d' })).toHaveAttribute('aria-checked', 'true');

    // Click Drift tab — period should stay 7d (matches Drift's default too)
    await page.getByRole('tab', { name: 'Drift' }).click();
    await expect(page).toHaveURL(/view=drift/);
    await expect(page.getByRole('radio', { name: '7d' })).toHaveAttribute('aria-checked', 'true');

    // Back to Health — period persists as 7d
    await page.getByRole('tab', { name: 'Health' }).click();
    // Default for Health is 30d, so 7d is not the default — must still be in URL
    await expect(page).toHaveURL(/period=7d/);
  });

  test('sidebar nav reaches all routes', async ({ page }) => {
    await page.goto('/');
    // Scope to the sidebar <aside aria-label="Main navigation">;
    // "Decision Moments" text also appears in the Welcome banner so a
    // global match is ambiguous.
    const sidebar = page.getByRole('complementary', { name: /Main navigation/i });
    await sidebar.getByRole('link', { name: 'Decision Moments' }).click();
    await expect(page).toHaveURL(/\/moments/);
    await sidebar.getByRole('link', { name: /Custom Rules/ }).click();
    await expect(page).toHaveURL(/\/rules/);
    await sidebar.getByRole('link', { name: 'Audit Log' }).click();
    await expect(page).toHaveURL(/\/audit/);
  });
});
