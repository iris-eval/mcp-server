import { join } from 'node:path';
import { homedir } from 'node:os';

/*
 * Single resolver for the iris home directory (default: ~/.iris).
 *
 * Every per-user file iris touches lives under this directory — the
 * SQLite DB default, config.json, custom-rules.json, audit.log,
 * preferences.json. Before this helper each module joined
 * homedir() + '.iris' itself, which meant there was no way to point a
 * spawned server at a scratch directory: the E2E suite isolated the DB
 * via IRIS_DB_PATH but still wiped the real audit.log, deployed test
 * rules into the real custom-rules.json, and overwrote the real
 * preferences.json on every run.
 *
 * IRIS_HOME redirects all of them at once. Read at call time — not
 * module load — so a test harness that sets the env var before
 * spawning (or between in-process calls) always wins.
 */
export function irisHome(): string {
  return process.env.IRIS_HOME ?? join(homedir(), '.iris');
}
