/*
 * Shared paths + constants for the Iris UAT harness.
 *
 * The iris repo is READ-ONLY to this harness. Everything the run writes
 * lives under UAT_DIR/.work, which is wiped at the start of every run so
 * the harness is idempotent.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));

/** tests/uat/ — the harness root. */
export const UAT_DIR = dirname(here);

/** Scratch root, wiped at run start. Git-ignored; the repo stays clean. */
export const WORK_DIR = join(UAT_DIR, '.work');

/*
 * The repo under test, derived from this file's own location
 * (<repo>/tests/uat/lib/env.mjs -> <repo>) rather than hardcoded, so the
 * harness works from a clone, a git worktree, or a CI runner. Everything
 * except dist/ and .work/ is read-only to this harness.
 */
export const IRIS_REPO = dirname(dirname(UAT_DIR));

export const IRIS_ENTRY = join(IRIS_REPO, 'dist', 'index.js');
export const IRIS_CLAIMS = join(IRIS_REPO, '.claims.json');
export const IRIS_NODE_MODULES = join(IRIS_REPO, 'node_modules');

export const REPORT_PATH = join(UAT_DIR, 'UAT-REPORT.md');

/**
 * The founder's REAL iris home. The harness must never touch any of
 * this. Hashed before + after the run; any change fails the harness.
 */
export const REAL_IRIS_HOME = join(homedir(), '.iris');

export const GUARDED_FILES = [
  'iris.db',
  'custom-rules.json',
  'audit.log',
  'preferences.json',
  'runtime.json',
  'demo.db',
  'demo-preferences.json',
  'demo-custom-rules.json',
  'demo-audit.log',
];

/** Named in the harness brief as the three that MUST be unchanged. */
export const CRITICAL_GUARDED_FILES = ['iris.db', 'custom-rules.json', 'audit.log'];

/**
 * Base env for every spawned iris process.
 *
 * IRIS_HOME is always overridden per-process by the caller. The rest
 * keeps runs hermetic: no browser launch, no inherited API keys (the
 * graceful-degradation checks depend on the keys being ABSENT), no
 * inherited IRIS_* config from the developer's shell.
 */
export function baseChildEnv(irisHome, extra = {}) {
  const env = {};
  // Windows needs these for node + better-sqlite3 to resolve at all.
  for (const key of [
    'APPDATA',
    'COMSPEC',
    'HOMEDRIVE',
    'HOMEPATH',
    'LOCALAPPDATA',
    'NUMBER_OF_PROCESSORS',
    'OS',
    'PATH',
    'PATHEXT',
    'PROCESSOR_ARCHITECTURE',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'USERNAME',
    'USERPROFILE',
    'WINDIR',
    'HOME',
    'LOGNAME',
    'SHELL',
    'TERM',
    'USER',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.IRIS_HOME = irisHome;
  env.IRIS_NO_AUTO_LAUNCH = '1';
  env.IRIS_LOG_LEVEL = 'error';
  // Explicitly NOT inherited: IRIS_ANTHROPIC_API_KEY / IRIS_OPENAI_API_KEY
  // / IRIS_API_KEY / IRIS_DB_PATH / IRIS_ALLOWED_ORIGINS.
  return { ...env, ...extra };
}
