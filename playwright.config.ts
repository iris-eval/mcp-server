/*
 * Playwright E2E suite — audit item #5.
 *
 * Spins up iris-mcp with the dashboard against a temp SQLite DB, seeds
 * a small deterministic dataset, then runs Chromium against the live
 * dashboard. Covers the critical flows a YC reviewer would walk:
 *
 *   - Fresh load + view navigation (smoke.spec.ts)
 *   - Drill-through from dashboard to moments (drill-through.spec.ts)
 *   - Make-This-A-Rule end-to-end (make-rule.spec.ts)
 *
 * The test DB lives in os.tmpdir() so local runs don't pollute the
 * user's real ~/.iris/iris.db. CI starts from a clean checkout so
 * pollution isn't a concern there; the same temp path still works.
 *
 * Port: 6921 (not the default 6920) so local iris-mcp dev servers can
 * run alongside tests without colliding.
 */
import { defineConfig, devices } from '@playwright/test';
import { E2E_PORT, E2E_DB_PATH, E2E_BASE_URL } from './tests/e2e/_constants.js';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false, // tests may share mutable state (audit log, rules file); keep sequential
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: E2E_BASE_URL,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
  },
  globalSetup: './tests/e2e/global-setup.ts',
  webServer: {
    /*
     * Starts iris-mcp with the dashboard on E2E_PORT. Uses the built
     * dist/ so we're exercising the same artifact that ships to npm.
     * IRIS_NO_AUTO_LAUNCH=1 keeps the server from opening a browser
     * window (Playwright drives its own).
     */
    command: `node dist/index.js --dashboard --dashboard-port ${E2E_PORT}`,
    url: `${E2E_BASE_URL}/api/v1/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      IRIS_DB_PATH: E2E_DB_PATH,
      IRIS_NO_AUTO_LAUNCH: '1',
    },
  },
  /*
   * Browser matrix: Chromium + Firefox.
   *
   * WebKit-on-Linux (Playwright's `webkit` device) is intentionally
   * excluded, not deferred. It is a Linux build of WebKit — NOT Apple
   * Safari. Safari uses Apple's WebKit which ships only on macOS
   * hardware. Testing Playwright's Linux WebKit build gives weak
   * assurance about actual Safari users and introduces environment-
   * specific flakiness (React 19 + Vite 8 hydration + WebKit-Linux
   * interact poorly on GitHub Actions Ubuntu runners).
   *
   * Real Safari coverage would require a macOS CI runner. That's an
   * honest cost/benefit call for a later decision: Iris is an MCP-
   * native dev tool consumed via Claude Desktop / Cursor / Windsurf /
   * IDE plugins — direct Safari dashboard access is a small slice of
   * usage. When Safari-real becomes material we add macOS to the CI
   * matrix explicitly rather than simulate it on Linux.
   *
   * Chromium covers ~65% real-world share; Firefox surfaces Gecko-
   * specific regressions (focus-management, layout-shift interaction).
   * Both pass reliably on ubuntu-latest + Windows + macOS.
   */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
  ],
});

