import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  SELF_TEST_STEPS,
  SELF_TEST_PASS_VERDICT,
  SELF_TEST_FAIL_VERDICT,
} from '../../src/self-test.js';

/*
 * The CLI contract for `iris-mcp --self-test`: a spawned process, a
 * report on stdout, and an exit code a shell script can trust (0 =
 * healthy, 1 = a check failed). Everything here runs the REAL entry
 * point — if the flag were removed from index.ts, the success test dies
 * on exit code 2 (unknown option) and the failure test on the missing
 * report.
 *
 * Spawned as `node node_modules/tsx/dist/cli.mjs` rather than `npx tsx`:
 * Windows cannot exec the npx shim without a shell, and the stdio
 * transport test only gets away with `npx` because the MCP SDK wraps
 * spawning in cross-spawn.
 */

const serverPath = resolve(import.meta.dirname, '../../src/index.ts');
const tsxCli = resolve(import.meta.dirname, '../../node_modules/tsx/dist/cli.mjs');

function runSelfTestCli(
  extraEnv: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [tsxCli, serverPath, '--self-test'], {
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', rejectPromise);
    child.once('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

describe('iris-mcp --self-test (CLI)', () => {
  let decoyHome: string;

  beforeAll(() => {
    decoyHome = mkdtempSync(join(tmpdir(), 'iris-selftest-cli-decoy-'));
  });

  afterAll(() => {
    rmSync(decoyHome, { recursive: true, force: true });
  });

  it('exits 0 on a healthy install and leaves the ambient IRIS_HOME untouched', async () => {
    /*
     * Decoy env travels the real child-env path, exactly like the stdio
     * transport test's IRIS_HOME assertion. If the spawned self-test
     * honoured any of it, either a file appears under decoyHome
     * (isolation breach) or the api key 401s its own probes (exit 1).
     */
    const { code, stdout } = await runSelfTestCli({
      IRIS_HOME: decoyHome,
      IRIS_DB_PATH: join(decoyHome, 'decoy.db'),
      IRIS_API_KEY: 'decoy-key',
    });

    expect(code).toBe(0);
    for (const label of Object.values(SELF_TEST_STEPS)) {
      expect(stdout).toContain(`✓ ${label}`);
    }
    expect(stdout).toContain(SELF_TEST_PASS_VERDICT);

    // The spawned process must not have written anything to the ambient home.
    expect(readdirSync(decoyHome)).toEqual([]);

    // The scratch home named in the report must be gone after the run.
    const tempHomeLine = stdout
      .split('\n')
      .find((l) => l.startsWith(`✓ ${SELF_TEST_STEPS.tempHome} — `));
    expect(tempHomeLine).toBeDefined();
    expect(existsSync(tempHomeLine!.split(' — ')[1].trim())).toBe(false);
  }, 60000);

  it('exits 1 when the install is broken (native addon cannot load)', async () => {
    /*
     * --no-addons makes better-sqlite3's native binding unloadable —
     * the same symptom as the most common genuinely broken install of
     * this package (ABI-mismatched prebuild after a Node upgrade). The
     * storage step must report the cross, cleanup must still run, and
     * the exit code must be exactly 1 (argument errors exit 2, so 1
     * pins the diagnostic's own failure path).
     */
    const { code, stdout } = await runSelfTestCli({ NODE_OPTIONS: '--no-addons' });

    expect(code).toBe(1);
    expect(stdout).toContain(`✗ ${SELF_TEST_STEPS.storage}`);
    expect(stdout).toContain(SELF_TEST_FAIL_VERDICT);
    expect(stdout).not.toContain(SELF_TEST_PASS_VERDICT);
    // A failed run still cleans up its scratch home.
    expect(stdout).toContain(`✓ ${SELF_TEST_STEPS.cleanup}`);
  }, 60000);

  it('exits 1 when the CONFIGURED IRIS_HOME cannot be created — the case that used to print PASS (#371)', async () => {
    // A file where a parent directory must go: a real mkdir failure on
    // every platform, through the real CLI and the real child env.
    const blocker = join(decoyHome, 'blocker-file');
    writeFileSync(blocker, 'not a directory');
    const unusableHome = join(blocker, '.iris');

    const { code, stdout } = await runSelfTestCli({ IRIS_HOME: unusableHome });

    expect(code).toBe(1);
    expect(stdout).toContain(`✗ ${SELF_TEST_STEPS.configuredHome}`);
    expect(stdout).toContain('Cannot create IRIS_HOME');
    expect(stdout).toContain(unusableHome);
    expect(stdout).toContain(SELF_TEST_FAIL_VERDICT);
    expect(stdout).not.toContain(SELF_TEST_PASS_VERDICT);
    // The isolated checks still ran and passed — the install is fine, the home is not.
    expect(stdout).toContain(`✓ ${SELF_TEST_STEPS.cleanEval}`);
    expect(stdout).toContain(`✓ ${SELF_TEST_STEPS.cleanup}`);
  }, 60000);
});
