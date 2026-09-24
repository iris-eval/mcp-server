/*
 * The demo is the engine's own output.
 *
 * `--demo` used to seed hand-shaped evaluations: a failing card read
 * "FAIL · Fail:" with nothing after the colon, a FAIL card said "2/2 pass",
 * Runs was empty, the Audit Log was empty and Drift had no prior period.
 * Now every seeded trace is judged by the real engine, the two runs and
 * their dataset exist, the demo's custom rules went through the store, and
 * the traffic spans two weeks. This spec reads the demo the way a first
 * visitor does, on a demo server of its own (tests/e2e/_server.ts).
 */
import { test, expect } from '@playwright/test';
import { startServer } from './_server.js';

test.describe('the demo is the engine\'s own output', () => {
  test('Failures names what failed, Runs compares two runs, Drift has a prior window, the Audit Log has rows', async ({ page }) => {
    test.setTimeout(120_000);
    const server = await startServer({ prefix: 'iris-e2e-demo-engine-', args: ['--demo'] });
    try {
      const health = (await (await fetch(`${server.baseUrl}/api/v1/health`)).json()) as { mode?: string };
      expect(health.mode).toBe('demo');

      // Failures: every card's label names at least one rule, and the chips agree.
      await page.goto(`${server.baseUrl}/`);
      const cards = page.locator('.moment-card');
      await expect(cards.first()).toBeVisible({ timeout: 30_000 });
      const labels = await cards.locator('.moment-card__sig').allTextContents();
      expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) {
        // "· Fail: min_output_length" / "· Safety: no_pii" / "· Cost: $0.1834 (…)" / "· First failure: …" — never "· Fail:" alone.
        expect(label.trim()).toMatch(/^· \S.*: \S/);
      }
      const chipCount = await cards.first().locator('.moment-card__chip').count();
      expect(chipCount).toBeGreaterThan(0);

      // Runs: the two seeded runs, compared with an interval; the bad deployment passed fewer.
      await page.goto(`${server.baseUrl}/runs`);
      await expect(page.locator('h1')).toHaveText('Runs');
      await expect(page.locator('[data-run-link="release-0.14"]')).toBeVisible();
      await expect(page.locator('[data-run-link="release-0.15"]')).toBeVisible();
      await page.locator('[data-compare-before]').selectOption('release-0.14');
      await page.locator('[data-compare-after]').selectOption('release-0.15');
      await page.locator('[data-compare-submit]').click();
      const cmp = page.locator('[data-comparison]');
      await expect(cmp).toBeVisible();
      await expect(cmp.locator('[data-method]')).toHaveText('paired-mcnemar');
      const before = await cmp.locator('[data-compare-run="before"]').textContent();
      const after = await cmp.locator('[data-compare-run="after"]').textContent();
      const passedOf = (text: string | null) => Number(/(\d+) of 12 passed/.exec(text ?? '')?.[1] ?? NaN);
      expect(passedOf(before)).toBeLessThan(passedOf(after));

      // Drift: two weeks of traffic, so the default 7d window has the week before it.
      const drift = (await (await fetch(`${server.baseUrl}/api/v1/eval-stats/drift?period=7d`)).json()) as {
        current: { evaluated: number };
        prior: { evaluated: number };
        enoughEvidence: boolean;
      };
      expect(drift.prior.evaluated).toBeGreaterThanOrEqual(10);
      expect(drift.enoughEvidence).toBe(true);
      await page.goto(`${server.baseUrl}/?view=drift`);
      // The banner compares once both windows have loaded (the prior window hydrates up to 200 moments);
      // while it loads it says so, and never claims there is no prior period.
      await expect(page.getByText(/Compared to the prior 7d/)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('No prior period to compare against yet')).toHaveCount(0);

      // Audit Log: the demo's own rules went through the store.
      await page.goto(`${server.baseUrl}/audit`);
      await expect(page.getByText('no_competitor_names').first()).toBeVisible();
      await expect(page.getByText('mentions_ticket_id').first()).toBeVisible();
    } finally {
      await server.stop();
    }
  });
});
