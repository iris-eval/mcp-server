/*
 * Runs, cases and the comparison (arc 7, D-5), driven through the real
 * dashboard on the seeded pair: baseline (traces 0–9, fails case-0 and
 * case-7) and candidate (traces 10–19, fails case-4), ten shared cases.
 */
import { test, expect } from '@playwright/test';

test.describe('runs and cases', () => {
  test('the runs list, the comparison through POST /api/v1/compare, a run, and a flaky case', async ({ page }) => {
    await page.goto('/runs');
    await expect(page.locator('h1')).toHaveText('Runs');
    await expect(page.locator('[data-run-link="baseline"]')).toBeVisible();
    await expect(page.locator('[data-run-link="candidate"]')).toBeVisible();

    await page.locator('[data-compare-before]').selectOption('baseline');
    await page.locator('[data-compare-after]').selectOption('candidate');
    await page.locator('[data-compare-submit]').click();
    const cmp = page.locator('[data-comparison]');
    await expect(cmp).toBeVisible();
    await expect(cmp.locator('[data-method]')).toHaveText('paired-mcnemar');
    await expect(cmp.locator('[data-compare-run="before"]')).toContainText('8 of 10 passed');
    await expect(cmp.locator('[data-compare-run="after"]')).toContainText('9 of 10 passed');
    await expect(cmp.locator('[data-comparison-verdict]')).toHaveText('NOT DISTINGUISHABLE');
    await expect(cmp.locator('[data-smallest-detectable]')).toBeVisible();

    await page.locator('[data-run-link="baseline"]').click();
    await expect(page.locator('[data-run-detail="baseline"]')).toBeVisible();
    await expect(page.locator('[data-run-passed]')).toHaveText('8 of 10 passed');

    await page.locator('[data-case-link="case-0"]').click();
    await expect(page.locator('[data-case-detail="case-0"]')).toBeVisible();
    await expect(page.locator('[data-case-flaky="true"]')).toBeVisible();
    await expect(page.locator('[data-case-attempts]')).toHaveText('1 of 2 attempts passed');
  });
});
