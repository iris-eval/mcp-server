/*
 * Shared constants for the Playwright E2E suite.
 *
 * Kept in a dedicated file (not imported from playwright.config) so
 * globalSetup + test files can import without circular dependency on
 * the config module.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** The port CI has always used; CI keeps it. */
export const CI_E2E_PORT = 6921;

/**
 * Which port the suite's dashboard listens on, decided once per run (#665).
 *
 *   - `E2E_PORT` set: that port.
 *   - In CI: 6921, as always.
 *   - Otherwise: a port the OS says is free right now.
 *
 * A fixed local port was answered by whatever was already listening there
 * — an `npx @iris-eval/mcp-server --dashboard-port 6921`, an earlier run's
 * server, another checkout's — and the suite quietly tested that build
 * instead of this one. The chosen port is written back to `E2E_PORT`, so
 * the worker processes Playwright starts after loading the config, and
 * globalSetup, all read the same number.
 */
export function resolveE2EPort(env: NodeJS.ProcessEnv = process.env, findFree: () => number = freePortSync): number {
  const fromEnv = env.E2E_PORT;
  if (fromEnv !== undefined && fromEnv !== '') {
    const port = Number(fromEnv);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`E2E_PORT must be a port number (1-65535); got "${fromEnv}"`);
    }
    return port;
  }
  const port = env.CI ? CI_E2E_PORT : findFree();
  env.E2E_PORT = String(port);
  return port;
}

/**
 * A free loopback port, found synchronously: the config is loaded
 * synchronously, and the port has to be known before the webServer
 * command is built. A child Node process binds port 0 and prints what the
 * OS gave it.
 */
function freePortSync(): number {
  const script =
    "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});";
  const port = Number(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim());
  if (!Number.isInteger(port) || port <= 0) throw new Error(`could not find a free port for the E2E dashboard (got "${port}")`);
  return port;
}

export const E2E_PORT = resolveE2EPort();
/*
 * One data directory per port outside CI, so two checkouts running the
 * suite side by side do not seed and wipe each other's database. CI keeps
 * the directory it has always used.
 */
export const E2E_DB_DIR = join(tmpdir(), process.env.CI ? 'iris-e2e' : `iris-e2e-${E2E_PORT}`);
export const E2E_DB_PATH = join(E2E_DB_DIR, 'iris.db');
/*
 * 127.0.0.1, not localhost — address the interface the dashboard actually
 * binds (config.dashboard.host, IPv4 loopback by default) instead of
 * relying on `localhost` resolving to ::1 first and falling back on
 * dual-stack hosts.
 *
 * Measured, so nobody re-derives it: this does NOT fix the intermittent
 * Firefox page.reload() timeout in v2c-chrome.spec — that reproduces the
 * same way against either address, and against a build without the
 * loopback-bind change. Root-caused in #334: helmet's
 * Cross-Origin-Opener-Policy header makes Firefox swap browsing-context
 * groups on navigation and Playwright's driver loses the frame. Fixed by
 * the firefoxUserPrefs block in playwright.config.ts (details there).
 */
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
