/*
 * The verdict panel and the ladder (arc 7, D-4), driven through the real
 * dashboard on the seeded $1.33 trace: cost_under_threshold fails against
 * the shipped $0.10, does not decide (the number is Iris's, not the
 * deployment's), the verdict passes, and the panel says why and names the
 * setting. "How was this computed?" opens the computation on every row.
 */
import { test, expect } from '@playwright/test';

test.describe('the verdict panel', () => {
  test('names the basis, the fired-but-advisory rule and its setting; the ladder opens the computation', async ({ page }) => {
    await page.goto('/traces/e2e-trace-0019');
    const panel = page.locator('[data-verdict-panel="cost"]');
    await expect(panel.locator('[data-verdict-state]')).toHaveText('PASS');
    await expect(panel.locator('[data-basis]')).toHaveAttribute('data-basis', 'clean');

    // The composer's own sentence: the rule that fired without deciding, and the one setting that would change it.
    const note = panel.locator('[data-interpretation-rule="cost_under_threshold"]');
    await expect(note).toBeVisible();
    await expect(note).toHaveAttribute('data-config-key', 'eval.defaultsGate');
    await expect(note).toContainText('cost_under_threshold failed against a threshold Iris ships');

    // Coverage by question, with the count of rules that ran.
    await expect(panel.locator('[data-question="within_budget"]')).toHaveAttribute('data-question-status', 'judged');

    // Default depth: the failed row shows its evidence; the computation waits behind the control.
    const row = page.locator('[data-rule-name="cost_under_threshold"]');
    await expect(row).toHaveAttribute('data-rule-state', 'failed');
    await expect(row.locator('[data-evidence-type="count"]')).toBeVisible();
    await expect(row.locator('[data-uncertainty]')).toHaveCount(0);

    await panel.getByRole('button', { name: 'How was this computed?' }).click();
    await expect(row.locator('[data-uncertainty="policy"]')).toBeVisible();
    await expect(panel.locator('[data-composer-facts]')).toContainText('eval.defaultsGate = false');
    await expect(panel.getByRole('button', { name: 'Hide how it was computed' })).toHaveAttribute('aria-expanded', 'true');
  });
});
