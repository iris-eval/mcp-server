/*
 * Shared constants for the Playwright E2E suite.
 *
 * Kept in a dedicated file (not imported from playwright.config) so
 * globalSetup + test files can import without circular dependency on
 * the config module.
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const E2E_PORT = 6921;
export const E2E_DB_DIR = join(tmpdir(), 'iris-e2e');
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
 * loopback-bind change. It is a pre-existing flake, tracked separately.
 */
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
