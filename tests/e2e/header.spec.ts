/*
 * The header states (arc 7, D-2), driven through the real dashboard.
 *
 *   - on a live server the pill says "live" and the judge chip states the
 *     judge from the server's own health answer;
 *   - when the server stops answering the pill goes red and says so;
 *   - a server started with --demo wears the DEMO chip.
 *
 * The stopped server is produced by aborting the health poll at the browser.
 * The demo server is a second process on its own port and its own IRIS_HOME,
 * killed at the end of the test.
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * A port the OS says is free, never a fixed number: a fixed port is answered
 * by whatever is already listening there, and a server left over from an
 * earlier run then passes or fails this test on its own behalf (S97, D-2:
 * a stale non-demo server on the fixed port hid the DEMO chip twice).
 */
function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

function exited(child: ChildProcess, budgetMs = 10_000): Promise<void> {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null) return resolveExit();
    const timer = setTimeout(resolveExit, budgetMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

async function waitForHealth(url: string, budgetMs = 30_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no health answer at ${url} within ${budgetMs} ms`);
}

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
    await expect(page.locator('h1')).toHaveText('Dashboard');
  });

  test('a demo server wears the DEMO chip', async ({ page }) => {
    const home = mkdtempSync(join(tmpdir(), 'iris-e2e-demo-'));
    const port = await freePort();
    const child = spawn(process.execPath, ['dist/index.js', '--dashboard', '--dashboard-port', String(port), '--demo'], {
      env: { ...process.env, IRIS_HOME: home, IRIS_NO_AUTO_LAUNCH: '1' },
      // stdin stays open: the MCP transport on stdio exits on EOF.
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    try {
      await waitForHealth(`http://127.0.0.1:${port}/api/v1/health`);
      // The server we just started is the one answering: its health says demo.
      const health = (await (await fetch(`http://127.0.0.1:${port}/api/v1/health`)).json()) as { mode?: string };
      expect(health.mode).toBe('demo');
      await page.goto(`http://127.0.0.1:${port}/`);
      await expect(page.locator('header [data-demo]')).toHaveText('DEMO');
      await expect(page.locator('header [data-status]')).toHaveAttribute('data-status', 'live');
    } finally {
      child.kill();
      await exited(child);
    }
  });
});
