/*
 * The header states, driven through the real dashboard.
 *
 *   - on a live server the pill says "live" and the judge chip states the
 *     judge from the server's own health answer;
 *   - when the server stops answering the pill goes red and says so;
 *   - a server started with --demo wears the DEMO chip.
 *
 * The stopped server is produced by aborting the health poll at the browser.
 * The demo server is a second process on its own free port and its own
 * IRIS_HOME (tests/e2e/_server.ts), killed at the end of the test.
 */
import { NAV_LABELS } from '../../dashboard/src/components/layout/navLabels.js';
import { test, expect } from '@playwright/test';
import { startServer } from './_server.js';

test.describe('header states', () => {
  test('on a live server the pill says live and the judge chip states the judge', async ({ page }) => {
    await page.goto('/');
    const pill = page.locator('header [data-status]');
    await expect(pill).toHaveAttribute('data-status', 'live');
    await expect(pill).toHaveText('live');
    // The chip reflects this process's environment: on when a provider key is set, off otherwise.
    const judge = page.locator('header [data-judge]');
    await expect(judge).toHaveAttribute('data-judge', /^(on|off)$/);
    await expect(judge).toHaveText(/^judge (off|\S+)$/);
    await expect(page.locator('header [data-demo]')).toHaveCount(0);
  });

  test('when the server stops answering the pill goes red and says so', async ({ page }) => {
    await page.route('**/api/v1/health', (route) => route.abort('connectionrefused'));
    await page.goto('/');
    const pill = page.locator('header [data-status]');
    await expect(pill).toHaveAttribute('data-status', 'unreachable');
    await expect(pill).toHaveText('unreachable');
    // The page itself is still up around it.
    await expect(page.locator('h1')).toHaveText(NAV_LABELS.failures);
  });

  test('a demo server wears the DEMO chip', async ({ page }) => {
    const server = await startServer({ prefix: 'iris-e2e-demo-', args: ['--demo'] });
    try {
      // The server we just started is the one answering: its health says demo.
      const health = (await (await fetch(`${server.baseUrl}/api/v1/health`)).json()) as { mode?: string };
      expect(health.mode).toBe('demo');
      await page.goto(`${server.baseUrl}/`);
      await expect(page.locator('header [data-demo]')).toHaveText('DEMO');
      await expect(page.locator('header [data-status]')).toHaveAttribute('data-status', 'live');
    } finally {
      await server.stop();
    }
  });
});
