import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runSelfTest,
  SELF_TEST_STEPS,
  SELF_TEST_PASS_VERDICT,
  SELF_TEST_FAIL_VERDICT,
} from '../../src/self-test.js';
import { PKG_VERSION } from '../../src/config/defaults.js';

/*
 * In-process exercise of the self-test sequence. The CLI-level contract
 * (spawned process, real exit codes) lives in
 * tests/integration/self-test-cli.test.ts; this file drives the same
 * sequence in-process where the assertions can be sharper: env restored,
 * decoy stores untouched, scratch home actually deleted.
 *
 * Anti-theater: none of these assertions pass vacuously. The decoy
 * IRIS_DB_PATH would GAIN a database file if isolation broke, the decoy
 * IRIS_API_KEY would 401 the self-test's own probes if the scrub broke,
 * and the parsed temp-home path would still exist if cleanup broke.
 */

const MUTATED_ENV_VARS = ['IRIS_DB_PATH', 'IRIS_API_KEY', 'IRIS_HOME', 'TMPDIR', 'TEMP', 'TMP'] as const;

describe('runSelfTest', () => {
  let decoyHome: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    decoyHome = mkdtempSync(join(tmpdir(), 'iris-selftest-decoy-'));
    savedEnv = {};
    for (const key of MUTATED_ENV_VARS) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of MUTATED_ENV_VARS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    rmSync(decoyHome, { recursive: true, force: true });
  });

  it('passes on a healthy install, ignores the ambient env, and cleans up after itself', async () => {
    /*
     * Decoys: if the self-test honoured the ambient env layer, the DB
     * would land in decoyHome (isolation breach) and the api key would
     * make its own health probe answer 401 (turning this test red).
     */
    process.env.IRIS_HOME = decoyHome;
    process.env.IRIS_DB_PATH = join(decoyHome, 'decoy.db');
    process.env.IRIS_API_KEY = 'decoy-key';

    const lines: string[] = [];
    const code = await runSelfTest((line) => lines.push(line));
    const out = lines.join('\n');

    expect(code).toBe(0);
    for (const label of Object.values(SELF_TEST_STEPS)) {
      expect(out).toContain(`✓ ${label}`);
    }
    expect(out).toContain(SELF_TEST_PASS_VERDICT);
    expect(out).toContain(`Iris self-test v${PKG_VERSION}`);
    expect(out).toContain(`version   ${PKG_VERSION}`);
    // The home + storage lines report where a NORMAL run of this install
    // keeps its data — the ambient IRIS_HOME / IRIS_DB_PATH, captured
    // before the scrub.
    expect(out).toContain(`home      ${decoyHome}`);
    expect(out).toContain(`storage   ${join(decoyHome, 'decoy.db')}`);
    // The configured home was probed (not merely reported) and found writable.
    expect(out).toContain(`✓ ${SELF_TEST_STEPS.configuredHome} — ${decoyHome} (database ${join(decoyHome, 'decoy.db')} will be created on first run)`);

    // Isolation: nothing may be LEFT under the ambient home/db path — the
    // write probe unlinks its file, and a missing database is not created.
    expect(readdirSync(decoyHome)).toEqual([]);

    // Cleanup: the scratch home the report names must be gone.
    const tempHomeLine = lines.find((l) => l.startsWith(`✓ ${SELF_TEST_STEPS.tempHome} — `));
    expect(tempHomeLine).toBeDefined();
    const tempHome = tempHomeLine!.split(' — ')[1];
    expect(tempHome).toBeTruthy();
    expect(existsSync(tempHome)).toBe(false);

    // Env restored verbatim — the diagnostic must not leak its scrub.
    expect(process.env.IRIS_HOME).toBe(decoyHome);
    expect(process.env.IRIS_DB_PATH).toBe(join(decoyHome, 'decoy.db'));
    expect(process.env.IRIS_API_KEY).toBe('decoy-key');
  });

  it('returns 1 and stops the sequence when a step fails', async () => {
    /*
     * Real fault, not a mock: point every tmpdir() source at a path whose
     * parent does not exist, so mkdtempSync fails with ENOENT exactly as
     * it would on a machine with a broken TEMP. (The CLI-level test
     * forces a different real fault — a native addon that cannot load.)
     */
    const bogusTmp = join(decoyHome, 'no-such-parent', 'tmp');
    process.env.TMPDIR = bogusTmp;
    process.env.TEMP = bogusTmp;
    process.env.TMP = bogusTmp;

    const lines: string[] = [];
    const code = await runSelfTest((line) => lines.push(line));
    const out = lines.join('\n');

    expect(code).toBe(1);
    expect(out).toContain(`✗ ${SELF_TEST_STEPS.tempHome}`);
    expect(out).toContain(SELF_TEST_FAIL_VERDICT);
    // First failure stops the run — no follow-on crosses burying the cause.
    expect(out).not.toContain(`✓ ${SELF_TEST_STEPS.storage}`);
    expect(out).not.toContain(`✗ ${SELF_TEST_STEPS.storage}`);
  });

  /*
   * #371 — the configured home is PROBED, not just printed. The diagnostic
   * used to pass on its temp home while the server died on startup with a
   * raw EPERM against the real IRIS_HOME.
   */
  it('fails — naming IRIS_HOME and the path — when the configured home cannot be created, and still runs the isolated checks', async () => {
    // A FILE where a parent directory must go, so mkdir fails on every
    // platform with a real errno rather than a mocked one.
    const blocker = join(decoyHome, 'blocker');
    writeFileSync(blocker, 'not a directory');
    const unusableHome = join(blocker, '.iris');
    process.env.IRIS_HOME = unusableHome;
    delete process.env.IRIS_DB_PATH;

    const lines: string[] = [];
    const code = await runSelfTest((line) => lines.push(line));
    const out = lines.join('\n');

    expect(code).toBe(1);
    const cross = lines.find((l) => l.startsWith(`✗ ${SELF_TEST_STEPS.configuredHome}`));
    expect(cross).toBeDefined();
    expect(cross).toContain('Cannot create IRIS_HOME');
    expect(cross).toContain(unusableHome);
    expect(cross).toContain('Point IRIS_HOME at a directory this user can write');
    expect(out).toContain(`${SELF_TEST_FAIL_VERDICT} — failed at: ${SELF_TEST_STEPS.configuredHome}`);
    // The configured-home failure does not halt the isolated sequence: the
    // user still learns whether the install itself works.
    expect(out).toContain(`✓ ${SELF_TEST_STEPS.tempHome}`);
    expect(out).toContain(`✓ ${SELF_TEST_STEPS.cleanEval}`);
    expect(out).toContain(`✓ ${SELF_TEST_STEPS.cleanup}`);
    expect(out).not.toContain(SELF_TEST_PASS_VERDICT);
    expect(out).toContain(`home      ${unusableHome}`);
  });

  it('opens an existing configured database for writing and reports it (no migration, no rows)', async () => {
    process.env.IRIS_HOME = decoyHome;
    delete process.env.IRIS_DB_PATH;
    // An existing (empty) database file — the shape a previous run leaves.
    const dbPath = join(decoyHome, 'iris.db');
    writeFileSync(dbPath, '');

    const lines: string[] = [];
    const code = await runSelfTest((line) => lines.push(line));
    const out = lines.join('\n');

    expect(code).toBe(0);
    expect(out).toContain(`✓ ${SELF_TEST_STEPS.configuredHome} — ${decoyHome} (database ${dbPath} opens for writing)`);
    // Opening for a lock probe must not have migrated or grown the file:
    // it is still the zero-byte file we wrote (SQLite creates nothing on
    // an immediately rolled-back transaction).
    expect(statSync(dbPath).size).toBe(0);
    // Only the database (and possibly its transient sidecars) exist — the
    // probe file was unlinked and nothing else was created.
    expect(readdirSync(decoyHome).filter((f) => !f.startsWith('iris.db'))).toEqual([]);
  });

  it('fails when the configured database exists but is not a database the server could open', async () => {
    process.env.IRIS_HOME = decoyHome;
    delete process.env.IRIS_DB_PATH;
    const dbPath = join(decoyHome, 'iris.db');
    writeFileSync(dbPath, 'this is not an sqlite file, just enough bytes to be rejected as one\n'.repeat(4));

    const lines: string[] = [];
    const code = await runSelfTest((line) => lines.push(line));

    expect(code).toBe(1);
    const cross = lines.find((l) => l.startsWith(`✗ ${SELF_TEST_STEPS.configuredHome}`));
    expect(cross).toBeDefined();
    expect(cross).toContain(`database "${dbPath}" exists but cannot be opened for writing`);
    expect(cross).toContain('IRIS_DB_PATH');
  });
});
