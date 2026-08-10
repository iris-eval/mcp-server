/*
 * Global vitest setup: point IRIS_HOME at a scratch directory before any
 * test file loads.
 *
 * PR #321 routed every per-user path (config.json, iris.db default,
 * custom-rules.json, audit.log, preferences.json) through irisHome(), and
 * isolated the two harnesses that SPAWN a server — Playwright's webServer
 * and the stdio integration test. It missed the in-process case: a unit or
 * integration test that builds a server directly from defaultConfig gets
 * the real ~/.iris, because vitest runs in the developer's own process.
 *
 * tests/integration/mcp-protocol.test.ts does exactly that. Its
 * deploy_rule/delete_rule round trip appended two rows to the developer's
 * REAL ~/.iris/audit.log on every run — caught by hashing the file before
 * and after a suite run, not by any assertion.
 *
 * Doing it here rather than per-file is the point: a future test that
 * forgets to pass a custom path is contained by default instead of
 * quietly writing to real user data. Set at module scope so it lands
 * before any import that reads the env.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const scratchHome = mkdtempSync(join(tmpdir(), 'iris-vitest-home-'));
process.env.IRIS_HOME = scratchHome;

afterAll(() => {
  rmSync(scratchHome, { recursive: true, force: true });
});
