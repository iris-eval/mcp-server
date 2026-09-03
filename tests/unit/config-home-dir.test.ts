import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ensureIrisDirectory, IRIS_HOME_DIR_MODE } from '../../src/config/index.js';

/*
 * #371 / #372 — how loadConfig creates IRIS_HOME.
 *
 * Runs on every platform and BRANCHES its assertions instead of skipping:
 * .claims.json captures test counts on a developer's machine and re-derives
 * them in CI on Linux, so a platform-skipped test would drift the truthbase
 * (scripts/claims/capture-tests.mjs refuses skipped tests for that reason).
 * File modes are a no-op on Windows; existence and the error contract are
 * asserted everywhere.
 */

let scratch: string;
let savedHome: string | undefined;
let savedDbPath: string | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'iris-home-mode-'));
  savedHome = process.env.IRIS_HOME;
  savedDbPath = process.env.IRIS_DB_PATH;
  delete process.env.IRIS_DB_PATH;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.IRIS_HOME;
  else process.env.IRIS_HOME = savedHome;
  if (savedDbPath === undefined) delete process.env.IRIS_DB_PATH;
  else process.env.IRIS_DB_PATH = savedDbPath;
  rmSync(scratch, { recursive: true, force: true });
});

describe('loadConfig creates IRIS_HOME', () => {
  it('creates a missing IRIS_HOME owner-only (0700 on POSIX; exists on Windows)', () => {
    const home = join(scratch, 'fresh', '.iris');
    process.env.IRIS_HOME = home;
    expect(existsSync(home)).toBe(false);

    loadConfig();

    expect(existsSync(home)).toBe(true);
    expect(IRIS_HOME_DIR_MODE).toBe(0o700);
    if (process.platform !== 'win32') {
      expect(statSync(home).mode & 0o777).toBe(0o700);
    } else {
      // ACLs govern on Windows; the mode bits are not meaningful there.
      expect(statSync(home).isDirectory()).toBe(true);
    }
  });

  it('creates the database directory when IRIS_DB_PATH points outside the home', () => {
    process.env.IRIS_HOME = join(scratch, 'home');
    const dbDir = join(scratch, 'elsewhere', 'data');
    process.env.IRIS_DB_PATH = join(dbDir, 'iris.db');

    const config = loadConfig();

    expect(config.storage.path).toBe(join(dbDir, 'iris.db'));
    expect(existsSync(dbDir)).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(dbDir).mode & 0o777).toBe(0o700);
    }
  });

  it('fails with ONE line naming IRIS_HOME and the path when the directory cannot be created', () => {
    // A FILE where a parent directory must go: mkdir fails on every platform.
    const blocker = join(scratch, 'blocker');
    writeFileSync(blocker, 'not a directory');
    const home = join(blocker, '.iris');
    process.env.IRIS_HOME = home;

    expect(() => loadConfig()).toThrow(/Cannot create IRIS_HOME/);
    // toThrow(string) is a substring match — the raw path, not a regex.
    expect(() => loadConfig()).toThrow(home);
    expect(() => loadConfig()).toThrow(/Point IRIS_HOME at a directory this user can write/);
  });

  it('ensureIrisDirectory leaves an existing directory alone (no chmod on a home the user already set up)', () => {
    const existing = join(scratch, 'existing');
    // Created with the platform default mode, deliberately.
    ensureIrisDirectory(join(scratch, 'existing'), 'test');
    const before = statSync(existing).mode;
    ensureIrisDirectory(existing, 'IRIS_HOME');
    expect(statSync(existing).mode).toBe(before);
  });
});
