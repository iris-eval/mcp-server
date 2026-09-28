/*
 * Does this machine's better-sqlite3 binary abort the process when V8
 * frees one of its statements, and does Iris predict it?
 *
 * A binary compiled against Node 24.19+ headers aborts on the first
 * collected statement on every 24.x release so far ("Assertion failed:
 * (env) != nullptr", nodejs/node#65446); the prebuilt binaries do not.
 * Iris reads the binary before loading it (nativeAbortsOnCollect) and uses
 * Node's built-in SQLite where it would abort. This runs the real binary
 * in a child process under the same allocation that aborts it, and holds
 * the prediction to the outcome both ways: on the ordinary CI jobs the
 * prebuilt binary survives and Iris says it would, and on the job that
 * compiles better-sqlite3 from source on Node 24 it aborts and Iris says
 * it would. The day a Node release carries the fix, this fails there, and
 * runtimeKeepsAddonHooks learns the version.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { nativeAbortsOnCollect, nativeBinaryPath, runtimeKeepsAddonHooks } from '../../src/storage/driver.js';

const FIXTURE = resolve(import.meta.dirname, '../fixtures/native-teardown/collect-statements.cjs');

describe('a better-sqlite3 binary that aborts on a collected statement', () => {
  it('aborts exactly when Iris predicts it, on this binary and this Node', () => {
    const binary = nativeBinaryPath();
    expect(binary, 'better-sqlite3 is installed in the test jobs, and the locator finds the file it loads').toBeDefined();
    const predicted = nativeAbortsOnCollect(binary);
    const run = spawnSync(process.execPath, [FIXTURE, '100000'], { encoding: 'utf8', timeout: 120_000 });
    const aborted = /Assertion failed: \(env\) != nullptr/.test(run.stderr);
    process.stdout.write(
      `[native-collect] Node ${process.versions.node}, ${binary}: ${aborted ? 'aborted' : 'survived'} (exit ${run.status ?? run.signal}); Iris predicted ${predicted ? 'abort' : 'survive'}; runtime keeps addon hooks: ${runtimeKeepsAddonHooks()}\n`,
    );
    expect(
      aborted,
      predicted
        ? 'Iris says this binary aborts on this Node, and it did not: if this Node carries the cleanup-hook fix, add its version to runtimeKeepsAddonHooks'
        : `Iris says this binary is safe on this Node, and it aborted:\n${run.stderr.slice(0, 2000)}`,
    ).toBe(predicted);
    expect(run.stdout.includes('survived')).toBe(!predicted);
  }, 150_000);
});
