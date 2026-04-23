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
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
