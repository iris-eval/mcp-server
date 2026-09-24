/*
 * Runs, cases and the comparison, driven through the real
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
    // The per-rule table carries p and the corrected q (two rules: the
    // seeded min_output_length failures and the $1.33 trace's cost rule), and the
    // equivalence chip is a separate statement from "not distinguishable".
    await expect(cmp.locator('[data-rules-tested]')).toHaveText('2 tested · corrected together');
    await expect(cmp.locator('[data-rule-row="min_output_length"]')).toHaveAttribute('data-rule-worse', 'false');
    await expect(cmp.locator('[data-rule-p]')).toHaveCount(2);
    await expect(cmp.locator('[data-rule-q]')).toHaveCount(2);
    await expect(cmp.locator('[data-equivalent-within]')).toHaveAttribute('data-equivalent-within', /true|false/);

    // The discordant cases are listed — case-4 regressed, case-0 and case-7 recovered — regressions first.
    await expect(cmp.locator('[data-discordant-row]')).toHaveCount(3);
    await expect(cmp.locator('[data-discordant-row]').first()).toHaveAttribute('data-discordant-direction', 'regressed');
    await expect(cmp.locator('[data-discordant-row="case-4"]')).toContainText('min_output_length');

    // Pin the baseline: the compare form starts from it after a reload, and a discordant row opens the moment.
    // Both browser projects share one server, so the click sets rather than toggles.
    const pin = page.locator('[data-run-pin="baseline"]');
    if ((await pin.getAttribute('aria-pressed')) !== 'true') await pin.click();
    await expect(page.locator('[data-run-baseline="baseline"]')).toBeVisible();
    await page.reload();
    await expect(page.locator('[data-compare-before]')).toHaveValue('baseline');
    await page.locator('[data-compare-after]').selectOption('candidate');
    await page.locator('[data-compare-submit]').click();
    await expect(page.locator('[data-comparison]')).toBeVisible();
    await page.locator('[data-discordant-open="case-4"]').click();
    await expect(page).toHaveURL(/\/traces\//);
    await page.goto('/runs');

    await page.locator('[data-run-link="baseline"]').click();
    await expect(page.locator('[data-run-detail="baseline"]')).toBeVisible();
    await expect(page.locator('[data-run-passed]')).toHaveText('8 of 10 passed');

    await page.locator('[data-case-link="case-0"]').click();
    await expect(page.locator('[data-case-detail="case-0"]')).toBeVisible();
    await expect(page.locator('[data-case-flaky="true"]')).toBeVisible();
    await expect(page.locator('[data-case-attempts]')).toHaveText('1 of 2 attempts passed');
  });
});
