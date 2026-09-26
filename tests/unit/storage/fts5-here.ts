/*
 * Which SQLite in this test process has FTS5 (#7).
 *
 * better-sqlite3's bundled SQLite always does. Node's built-in node:sqlite
 * does from Node 22.16.0: 22.13.0, 22.14.0 and 22.15.0 answer "no such
 * module: fts5" (checked on each release). The CI search-index job runs the
 * built-in at 22.13.0 on purpose, so the fallback is proven on a real SQLite
 * without FTS5 and not only through the adapter's test override.
 *
 * Suites about the index itself run on SEARCH_DRIVER: this cell's driver
 * when it has FTS5, better-sqlite3 otherwise. Nothing is skipped.
 */
import { openDriver, requestedDriver } from '../../../src/storage/driver.js';
import { fts5Available } from '../../../src/storage/search-index.js';

export const NODE_SQLITE_FTS5_FROM = '22.16.0';

function nodeAtLeast(version: string): boolean {
  const [a, b, c] = process.versions.node.split('.').map(Number);
  const [x, y, z] = version.split('.').map(Number);
  return a !== x ? a > x : b !== y ? b > y : c >= z;
}

/** What the docs promise for a driver on this Node. */
export function expectedFts5(driver: 'native' | 'node'): boolean {
  return driver === 'native' || nodeAtLeast(NODE_SQLITE_FTS5_FROM);
}

export function driverHasFts5(driver: 'native' | 'node'): boolean {
  const db = openDriver(':memory:', { driver });
  try {
    return fts5Available(db);
  } finally {
    db.close();
  }
}

/** The driver this cell runs (IRIS_SQLITE_DRIVER), native when unset. */
export const CELL_DRIVER: 'native' | 'node' = requestedDriver() ?? 'native';

/** The driver the index suites run on. */
export const SEARCH_DRIVER: 'native' | 'node' = driverHasFts5(CELL_DRIVER) ? CELL_DRIVER : 'native';
