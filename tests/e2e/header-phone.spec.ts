/*
 * The top bar holds at phone width.
 *
 * At 400 × 820 the palette trigger used to run under the status chips on
 * every page — "Search / jump to…" over `judge off` and `DEMO`. Now the
 * trigger is its icon below 768 px, the title row wraps its chips, and the
 * header grows to fit. This spec measures it: on four pages of a demo
 * server (so all three chips exist) no two top-bar children overlap, and
 * every chip is visible.
 */
import { test, expect, type Page } from '@playwright/test';
import { startServer } from './_server.js';

test.use({ viewport: { width: 400, height: 820 } });

const TOP_BAR_CHILDREN = [
  'header h1',
  'header [data-status]',
  'header [data-judge]',
  'header [data-demo]',
  'header button[aria-label="Open command palette"]',
  'header button[aria-label^="Notifications"]',
  'header button[aria-label="Account menu"]',
];

async function boxes(page: Page): Promise<Array<{ sel: string; x: number; y: number; w: number; h: number }>> {
  const out: Array<{ sel: string; x: number; y: number; w: number; h: number }> = [];
  for (const sel of TOP_BAR_CHILDREN) {
    const el = page.locator(sel).first();
    if ((await el.count()) === 0) continue;
    const b = await el.boundingBox();
    if (b) out.push({ sel, x: b.x, y: b.y, w: b.width, h: b.height });
  }
  return out;
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  // Two boxes overlap when they share area — a one-pixel touch does not count.
  return a.x + a.w > b.x + 1 && b.x + b.w > a.x + 1 && a.y + a.h > b.y + 1 && b.y + b.h > a.y + 1;
}

test.describe('the top bar at phone width', () => {
  test('no two top-bar children overlap on the dashboard, the moments, the rules and the audit pages', async ({ page }) => {
    test.setTimeout(120_000);
    const server = await startServer({ prefix: 'iris-e2e-header-phone-', args: ['--demo'] });
    try {
      for (const path of ['/', '/moments', '/rules', '/audit']) {
        await page.goto(`${server.baseUrl}${path}`);
        await expect(page.locator('header [data-demo]')).toBeVisible();
        await expect(page.locator('header [data-judge]')).toBeVisible();
        await expect(page.locator('header [data-status]')).toBeVisible();
        await expect(page.locator('header [data-palette-trigger]')).toHaveAttribute('data-palette-trigger', 'compact');
        await expect(page.locator('header')).toHaveAttribute('data-header-layout', 'narrow');
        const bs = await boxes(page);
        expect(bs.length).toBeGreaterThanOrEqual(6);
        for (let i = 0; i < bs.length; i++) {
          for (let j = i + 1; j < bs.length; j++) {
            expect(overlaps(bs[i], bs[j]), `${path}: ${bs[i].sel} overlaps ${bs[j].sel}`).toBe(false);
          }
        }
        // Nothing in the top bar runs past the viewport.
        for (const b of bs) expect(b.x + b.w, `${path}: ${b.sel} past the right edge`).toBeLessThanOrEqual(400);
      }
    } finally {
      await server.stop();
    }
  });
});
