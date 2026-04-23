/*
 * Drill-through E2E tests.
 *
 * Validates the REAL navigation behavior that unit tests can't cover:
 * click a dashboard element → router navigates → target page loads with
 * the expected filter applied.
 *
 * Chart rendering is unit-tested elsewhere (tests/a11y/charts.test.tsx
 * proves the hidden drill-through lists are present in the DOM when
 * data is populated). Here we verify the wire-up holds end-to-end.
 */
import { test, expect } from '@playwright/test';

test.describe('drill-through from dashboard', () => {
  test('clicking a verdict donut legend row drills to /moments?verdict=', async ({ page }) => {
    await page.goto('/');

    // The verdict donut's legend exposes Links with descriptive
    // aria-labels. Seed data guarantees "Pass" has count > 0.
    const passLink = page.getByRole('link', { name: /Pass:.*drill into moments/i });
    await passLink.click();

    await expect(page).toHaveURL(/\/moments\?.*verdict=pass/);
  });

  test('top-failing-rules row drills to /moments with filter', async ({ page }) => {
    await page.goto('/');

    // TopFailingRulesBars renders one Link per failing rule. Seed has
    // ~3 failures, all on min_output_length, so this should click.
    // Scope to the Top failing rules region so we don't accidentally
    // match something else named min_output_length.
    const topFailing = page.getByRole('region', { name: 'Top failing rules' });
    const firstRule = topFailing.getByRole('link').first();
    await firstRule.click();
    // TopFailingRules drills to /moments with a `kind` filter.
    await expect(page).toHaveURL(/\/moments\?.*kind=/);
  });

  test('biggest-movers row drills to /moments with agent filter', async ({ page }) => {
    await page.goto('/');

    const movers = page.getByRole('region', { name: 'Biggest movers' });
    const firstMover = movers.getByRole('link').first();
    await firstMover.click();
    await expect(page).toHaveURL(/\/moments\?.*agent=/);
  });
});
