/*
 * scripts/check-tools-listed.mjs starts the server to read tools/list. Run on
 * a developer's machine it must never start it on their own Iris data: a run
 * that did opened ~/.iris/iris.db and applied a migration the installed
 * release did not know, so that release then refused to open its database.
 *
 * The script is run for real against a stand-in server
 * (tests/fixtures/check-tools-listed/stand-in-server.mjs) that records the
 * IRIS_HOME and IRIS_DB_PATH it was started with and answers only when both
 * are set. The caller's own IRIS_HOME and IRIS_DB_PATH are set to a directory
 * standing in for their real one, which must be left untouched.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-tools-listed.mjs');
const STAND_IN = join(ROOT, 'tests', 'fixtures', 'check-tools-listed', 'stand-in-server.mjs');
const TOOLS = JSON.parse(readFileSync(join(ROOT, '.claims.json'), 'utf8')).mcpTools.names as string[];

let scratch: string;
let callersHome: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'iris-tools-listed-test-'));
  callersHome = join(scratch, 'callers-real-iris-home');
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function check(mode: 'ok' | 'short' | 'exit') {
  const envOut = join(scratch, 'env.json');
  const run = spawnSync(process.execPath, [SCRIPT, STAND_IN], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      IRIS_HOME: callersHome,
      IRIS_DB_PATH: join(callersHome, 'iris.db'),
      STAND_IN_ENV_OUT: envOut,
      STAND_IN_MODE: mode,
    },
  });
  const seen = existsSync(envOut) ? (JSON.parse(readFileSync(envOut, 'utf8')) as { IRIS_HOME: string | null; IRIS_DB_PATH: string | null }) : null;
  return { run, seen };
}

describe('check-tools-listed starts the server on a throwaway Iris home', () => {
  it('sets IRIS_HOME and IRIS_DB_PATH to a fresh temp directory over the caller\'s own, and removes it', () => {
    const { run, seen } = check('ok');

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`${TOOLS.length} tools listed`);
    expect(seen?.IRIS_HOME).toBeTruthy();
    expect(seen?.IRIS_DB_PATH).toBe(join(seen!.IRIS_HOME!, 'iris.db'));
    expect(seen!.IRIS_HOME).not.toBe(callersHome);
    expect(realpathSync(dirname(seen!.IRIS_HOME!))).toBe(realpathSync(tmpdir()));
    expect(seen!.IRIS_HOME!.split(/[\\/]/).pop()).toMatch(/^iris-tools-listed-/);
    // Removed on exit, and nothing was created where the caller's own home points.
    expect(existsSync(seen!.IRIS_HOME!)).toBe(false);
    expect(existsSync(callersHome)).toBe(false);
  });

  it('fails, naming the missing tool, when tools/list comes back short', () => {
    const { run } = check('short');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`expected ${TOOLS.length}, missing ${TOOLS[0]}`);
  });

  it('fails, rather than hanging or passing, when the server exits before answering', () => {
    const { run } = check('exit');
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/server exited \(5\) before answering tools\/list/);
  });

  it('leaves no temp home behind on failure either', () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('iris-tools-listed-') && !n.startsWith('iris-tools-listed-test-'));
    const { seen } = check('exit');
    expect(existsSync(seen!.IRIS_HOME!)).toBe(false);
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith('iris-tools-listed-') && !n.startsWith('iris-tools-listed-test-'));
    expect(after.filter((n) => !before.includes(n))).toEqual([]);
  });
});
