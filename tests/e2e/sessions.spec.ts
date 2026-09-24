/*
 * Sessions: three seeded traces share one session; the trace
 * page shows the strip with the turn's place in it, and the next-turn link
 * lands on the next trace.
 *
 * The seed dates a trace older as its index grows (global-setup: hoursAgo
 * = i × SPREAD_HOURS), so in time order the session runs 0005 → 0004 →
 * 0003: the strip reads time, not ids.
 */
import { test, expect } from '@playwright/test';

test.describe('sessions', () => {
  test('the trace drawer shows the session strip and walks to the next turn', async ({ page }) => {
    await page.goto('/traces/e2e-trace-0004');
    const strip = page.locator('[data-session-strip="e2e-session-1"]');
    await expect(strip).toBeVisible();
    await expect(strip.locator('[data-session-turn]')).toHaveText('turn 2 of 3');
    await expect(strip.locator('[data-session-prev="e2e-trace-0005"]')).toBeVisible();
    await expect(strip.locator('[data-session-turn-link]')).toHaveCount(3);
    await strip.locator('[data-session-next="e2e-trace-0003"]').click();
    await expect(page).toHaveURL(/\/traces\/e2e-trace-0003$/);
    await expect(page.locator('[data-session-strip="e2e-session-1"] [data-session-turn]')).toHaveText('turn 3 of 3');
    await expect(page.locator('[data-session-next]')).toHaveCount(0);
    await expect(page.locator('[data-session-prev="e2e-trace-0004"]')).toBeVisible();

    // A trace outside any session shows no strip.
    await page.goto('/traces/e2e-trace-0000');
    await expect(page.locator('h2#trace-summary-title')).toBeVisible();
    await expect(page.locator('[data-session-strip]')).toHaveCount(0);
  });
});
