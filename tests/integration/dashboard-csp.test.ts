/*
 * The dashboard's Content-Security-Policy, as a browser receives it.
 *
 * helmet adds `upgrade-insecure-requests` by default. The dashboard server
 * speaks plain HTTP, and Safari applies that directive to http://localhost
 * where Chrome and Firefox exempt it: Safari fetched the page's own scripts
 * and styles from https://localhost:<port>/, got no TLS answer, and showed
 * an empty page. Found by the WebKit project of the Playwright suite
 * (playwright.config.ts), which runs on macOS in CI; this holds the header
 * itself on every OS.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { defaultConfig } from '../../src/config/defaults.js';

const mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let storage: SqliteAdapter | undefined;
let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections?.();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await storage?.close();
  server = undefined;
  storage = undefined;
});

async function pagePolicy(): Promise<string> {
  storage = new SqliteAdapter(':memory:');
  await storage.initialize();
  const config = { ...defaultConfig, dashboard: { ...defaultConfig.dashboard, port: 0 } };
  server = createDashboardServer(storage, config, mockLogger).start();
  await new Promise((r) => server!.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const page = await fetch(`http://127.0.0.1:${port}/`, { headers: { accept: 'text/html' } });
  return page.headers.get('content-security-policy') ?? '';
}

describe('the dashboard Content-Security-Policy', () => {
  it('does not ask the browser to upgrade its plain-HTTP requests to https', async () => {
    const policy = await pagePolicy();
    expect(policy).not.toBe('');
    expect(policy).not.toMatch(/upgrade-insecure-requests/);
  });

  it('still allows scripts, styles and requests from its own origin only', async () => {
    const directives = new Map(
      (await pagePolicy())
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => [d.split(/\s+/)[0], d.split(/\s+/).slice(1).join(' ')] as const),
    );
    expect(directives.get('default-src')).toBe("'self'");
    expect(directives.get('script-src')).toBe("'self'");
    expect(directives.get('connect-src')).toBe("'self'");
    expect(directives.get('object-src')).toBe("'none'");
  });
});
