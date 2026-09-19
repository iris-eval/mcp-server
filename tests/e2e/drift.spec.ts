/*
 * Drift by run (arc 7, D-6), driven through the real dashboard on the seeded
 * pair: split the Drift view by run and each cohort shows its n and the
 * interval on its window.
 */
import { test, expect } from '@playwright/test';

test.describe('drift by run', () => {
  test('the cohort selector splits the view; each run shows n and its interval', async ({ page }) => {
    await page.goto('/?view=drift&period=7d');
    await expect(page.getByRole('tab', { name: 'Drift' })).toHaveAttribute('aria-selected', 'true');
    await page.locator('[data-cohort-option="run"]').click();
    await expect(page).toHaveURL(/cohort=run/);
    const baseline = page.locator('[data-cohort="baseline"]');
    const candidate = page.locator('[data-cohort="candidate"]');
    await expect(baseline).toBeVisible();
    await expect(candidate).toBeVisible();
    await expect(baseline.locator('[data-cohort-n]')).toHaveAttribute('data-cohort-n', '10');
    await expect(candidate.locator('[data-cohort-n]')).toHaveAttribute('data-cohort-n', '10');
    // n and the Wilson interval on this window, from the server.
    await expect(baseline.locator('[data-cohort-current]')).toContainText('8 of 10 passed · 80.0% [');
    await expect(candidate.locator('[data-cohort-current]')).toContainText('9 of 10 passed · 90.0% [');
    // The seed has no prior window, so no direction is offered.
    await expect(baseline.locator('[data-cohort-verdict]')).toHaveText('NOT COMPARED');
    await page.locator('[data-cohort-option="all"]').click();
    await expect(page).not.toHaveURL(/cohort=run/);
    await expect(page.locator('[data-cohort]')).toHaveCount(0);
  });
});
