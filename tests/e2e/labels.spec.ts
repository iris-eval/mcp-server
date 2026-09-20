/*
 * Labels on your own traffic (arc 7, D-8, held by D-9), driven through the
 * real dashboard on a trace this spec stores for itself: the fired rule
 * asks whether it was right to fire, the label is written and the card
 * says where the rule's local precision stands, the /rules panel shows the
 * label, the Failures page groups fires into issues, and re-scoring keeps
 * the earlier evaluation and names it on the new one.
 *
 * Its own trace, on purpose. Re-scoring adds an evaluation to a trace and
 * changes what every newest-per-trace reader sees: the first full run put
 * this on the seeded $1.33 trace and broke the verdict and 390 px specs
 * (two verdict panels); the second put it on a seeded baseline trace and
 * broke the runs comparison (the baseline gained a pass). A spec that
 * writes must own what it writes to. The assertions are relative where a
 * count could differ between the Chromium and Firefox projects, which run
 * against one store.
 */
import { test, expect } from '@playwright/test';

test.describe('labels', () => {
  test('label a fire, see it on /rules, re-score the trace', async ({ page, request }) => {
    // A stub answer: no_stub_output fires, deterministically, on an inference that enters the risk.
    const stored = await request.post('/api/v1/traces', {
      data: { agent_name: 'labels-spec', input: 'Summarise the release notes.', output: 'TODO: write the summary.', evaluate: true },
    });
    expect(stored.status()).toBe(201);
    const { trace_id: traceId, evaluation } = (await stored.json()) as { trace_id: string; evaluation: { id: string } };
    const evalId = evaluation.id;

    await page.goto(`/traces/${traceId}`);
    const card = page.locator(`[data-eval-id="${evalId}"]`);
    await expect(card).toBeVisible();
    const row = card.locator('[data-rule-name="no_stub_output"]');
    await expect(row).toHaveAttribute('data-rule-state', 'failed');
    const control = row.locator('[data-label-control="no_stub_output"]');
    await expect(control).toBeVisible();
    // A quiet rule asks nothing.
    await expect(card.locator('[data-label-control="no_pii"]')).toHaveCount(0);

    const written = page.waitForResponse((res) => res.url().endsWith('/api/v1/labels') && res.request().method() === 'POST');
    await control.getByRole('button', { name: 'wrong' }).click();
    expect((await written).status()).toBe(201);
    await expect(control).toHaveAttribute('data-label', 'wrong');
    await expect(control.getByRole('button', { name: 'wrong' })).toHaveAttribute('aria-pressed', 'true');
    const note = card.locator('[data-eval-note]');
    await expect(note).toContainText('no_stub_output:');
    await expect(note).toContainText('of 20 labels');
    await expect(note).toContainText('before it replaces the published number here');

    // The label survives a reload: read back from the server, not remembered by the page.
    await page.reload();
    await expect(page.locator(`[data-eval-id="${evalId}"] [data-label-control="no_stub_output"]`)).toHaveAttribute('data-label', 'wrong');

    // /rules: the panel shows the label and the distance to the floor.
    await page.goto('/rules');
    const panel = page.locator('[data-local-precision-panel="true"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-label-count="no_stub_output"]')).toContainText('wrong');
    await expect(panel.locator('[data-local-precision="no_stub_output"]')).toContainText('n = ');
    await expect(panel.locator('[data-local-in-force="no_stub_output"]')).toHaveCount(0);
    await expect(panel).toContainText(' more');

    // Re-score: the earlier evaluation stays, one more appears, the new one names the old.
    await page.goto(`/traces/${traceId}`);
    await expect(card).toBeVisible();
    const before = await page.locator('[data-eval-id]').count();
    expect(before).toBeGreaterThanOrEqual(1);
    const rescored = page.waitForResponse((res) => res.url().includes('/reevaluate') && res.request().method() === 'POST');
    await page.locator(`[data-reevaluate="${evalId}"]`).click();
    expect((await rescored).status()).toBe(201);
    await expect(card.locator('[data-eval-note]')).toContainText('Re-scored: verdict');
    await expect(page.locator('[data-eval-id]')).toHaveCount(before + 1);
    await expect(page.locator(`[data-supersedes="${evalId}"]`).first()).toBeVisible();
  });

  test('the Failures page groups fires into recurring issues', async ({ page }) => {
    await page.goto('/');
    const issues = page.locator('[data-issues="true"]');
    await expect(issues).toBeVisible();
    // Three seeded min_output_length fires (traces 0, 7, 14) share one message: one issue with a count of 3.
    // Keyed by the signature, not the rule: the stub this file stored is short too, and the real rule's
    // fire on it carries a different message — a second, separate min_output_length issue, by design.
    const seeded = issues.locator('tr', { has: page.locator('[data-issue-signature]', { hasText: 'message:output too short' }) });
    await expect(seeded.locator('[data-issue-rule]')).toHaveText('min_output_length');
    await expect(seeded.locator('[data-issue-count]')).toHaveText('3');
    await expect(seeded.getByRole('link', { name: 'open one' })).toHaveAttribute('href', /^\/traces\/e2e-trace-/);
    // The stub this file stored is an issue of its own, with the label it wrote.
    const stub = issues.locator('tr', { has: page.locator('[data-issue-rule="no_stub_output"]') });
    await expect(stub.locator('[data-issue-labelled]')).toContainText('wrong');
  });
});
