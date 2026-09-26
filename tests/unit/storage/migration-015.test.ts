/*
 * Migration 015 — full-text search over traces (#7).
 *
 * The index and its triggers on a cold file; on a database written before
 * the migration, the traces already stored are indexed by it; applied once;
 * and on a SQLite without FTS5 it is recorded as applied with nothing
 * created, so the rest of the schema never depends on FTS5. The count of
 * known migrations belongs to the newest migration's test, this one.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { KNOWN_MIGRATION_IDS } from '../../../src/storage/migrations/index.js';
import { LOCAL_TENANT, asTenantId } from '../../../src/types/tenant.js';
import { fts5Available } from '../../../src/storage/search-index.js';
import type { Driver } from '../../../src/storage/driver.js';
import { CELL_DRIVER, NODE_SQLITE_FTS5_FROM, SEARCH_DRIVER, expectedFts5 } from './fts5-here.js';

// File-backed stores, several opens per test: 70-90 ms on a Windows laptop, up to 8 s on a hosted Windows runner (CI, 2026-09-26).
vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iris-mig015-'));
  dirs.push(dir);
  return join(dir, 'iris.db');
}

const SEARCH_OBJECTS = "SELECT type, name FROM sqlite_master WHERE name LIKE 'trace_search%' AND name NOT LIKE 'sqlite_%' ORDER BY type, name";

describe('migration 015 — the trace search index', () => {
  it(`this cell's driver has FTS5 exactly when promised (better-sqlite3 always, node:sqlite from Node ${NODE_SQLITE_FTS5_FROM}), and search answers either way`, async () => {
    const path = tempDb();
    const store = new SqliteAdapter(path, { driver: CELL_DRIVER });
    await store.initialize();
    const db = (store as unknown as { db: Driver }).db;
    const version = (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
    const has = fts5Available(db);
    expect(has, `SQLite ${version} on ${store.driver}, Node ${process.versions.node}`).toBe(expectedFts5(CELL_DRIVER));
    if (has) {
      // secure-delete arrived in 3.42.0.
      const [major, minor] = version.split('.').map(Number);
      expect(major * 1000 + minor, `SQLite ${version}`).toBeGreaterThanOrEqual(3042);
    }
    // End to end on this SQLite as it is: no override, no simulation.
    await store.insertTraces(LOCAL_TENANT, [
      { trace_id: 'a', agent_name: 'bot', output: 'The refund was approved on Monday.', timestamp: '2026-09-01T00:00:00.000Z' },
      { trace_id: 'b', agent_name: 'bot', output: 'Refund refused: past the window.', tool_calls: [{ tool_name: 'lookup', input: { reason: 'window' } }], timestamp: '2026-09-02T00:00:00.000Z' },
    ]);
    const found = await store.queryTraces(LOCAL_TENANT, { search: 'refund' });
    expect(found.search?.index).toBe(has ? 'fts5' : 'scan');
    expect(found.traces.map((t) => t.trace_id).sort()).toEqual(['a', 'b']);
    expect(found.traces.every((t) => t.match?.fragments.some((f) => f.hit))).toBe(true);
    expect((await store.queryTraces(LOCAL_TENANT, { search: '"refund was"' })).traces.map((t) => t.trace_id)).toEqual(['a']);
    expect(await store.deleteTrace(LOCAL_TENANT, 'a')).toBe(true);
    expect((await store.queryTraces(LOCAL_TENANT, { search: 'approved' })).total).toBe(0);
    await store.close();
    if (!has) {
      // The same file on a driver with FTS5 is indexed at its first start, including what the scan-only start wrote.
      const later = new SqliteAdapter(path, { driver: 'native' });
      await later.initialize();
      const again = await later.queryTraces(LOCAL_TENANT, { search: 'refund' });
      expect(again.search?.index).toBe('fts5');
      expect(again.traces.map((t) => t.trace_id)).toEqual(['b']);
      await later.close();
    }
  });

  it('is the fifteenth known migration, and the last', () => {
    expect(KNOWN_MIGRATION_IDS).toHaveLength(15);
    expect(KNOWN_MIGRATION_IDS[14]).toBe('015-trace-search');
    expect(KNOWN_MIGRATION_IDS[13]).toBe('014-trace-session');
  });

  it('creates the index, its id table, its covering index and two triggers on a cold file, once', async () => {
    const path = tempDb();
    const store = new SqliteAdapter(path, { driver: SEARCH_DRIVER });
    await store.initialize();
    await store.close();
    const again = new SqliteAdapter(path, { driver: SEARCH_DRIVER });
    await again.initialize();
    await again.close();

    const db = new Database(path, { readonly: true });
    const objects = db.prepare(SEARCH_OBJECTS).all() as Array<{ type: string; name: string }>;
    expect(objects.filter((o) => o.type === 'trigger').map((o) => o.name)).toEqual(['trace_search_ad', 'trace_search_au']);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_traces_search_filter'").get()).toBeDefined();
    expect(objects.filter((o) => o.type === 'table').map((o) => o.name)).toEqual(
      expect.arrayContaining(['trace_search', 'trace_search_docs', 'trace_search_data', 'trace_search_idx']),
    );
    const applied = (db.prepare('SELECT id FROM _iris_migrations ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
    expect(applied).toEqual([...KNOWN_MIGRATION_IDS]);
    expect(applied.filter((id) => id === '015-trace-search')).toHaveLength(1);
    db.close();
  });

  it('indexes the traces a database already held when it was written before the migration', async () => {
    const path = tempDb();
    const store = new SqliteAdapter(path, { driver: SEARCH_DRIVER });
    await store.initialize();
    await store.insertTraces(LOCAL_TENANT, [
      { trace_id: 'old-1', agent_name: 'bot', input: 'Where is parcel 7781?', output: 'Parcel 7781 left the depot this morning.', timestamp: '2026-08-01T00:00:00.000Z' },
      { trace_id: 'old-2', agent_name: 'bot', output: 'Nothing to report.', tool_calls: [{ tool_name: 'track', input: { carrier: 'Royal Mail' } }], timestamp: '2026-08-02T00:00:00.000Z' },
    ]);
    await store.insertTraces(asTenantId('acme'), [{ trace_id: 'old-3', agent_name: 'bot', output: 'parcel delivered', timestamp: '2026-08-03T00:00:00.000Z' }]);
    await store.close();

    // Put the file back the way a 0.19 build left it: no search objects, and 015 not applied.
    const raw = new Database(path);
    raw.exec(`
      DROP TRIGGER trace_search_au; DROP TRIGGER trace_search_ad;
      DROP TABLE trace_search; DROP TABLE trace_search_docs; DROP INDEX idx_traces_search_filter;
      DELETE FROM _iris_migrations WHERE id = '015-trace-search';
    `);
    expect(raw.prepare(SEARCH_OBJECTS).all()).toEqual([]);
    expect(raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_traces_search_filter'").get()).toBeUndefined();
    raw.close();

    const upgraded = new SqliteAdapter(path, { driver: SEARCH_DRIVER });
    await upgraded.initialize();
    const page = await upgraded.queryTraces(LOCAL_TENANT, { search: 'parcel' });
    expect(page.search?.index).toBe('fts5');
    expect(page.traces.map((t) => t.trace_id)).toEqual(['old-1']);
    expect((await upgraded.queryTraces(LOCAL_TENANT, { search: 'royal mail' })).traces.map((t) => t.trace_id)).toEqual(['old-2']);
    expect((await upgraded.queryTraces(asTenantId('acme'), { search: 'parcel' })).traces.map((t) => t.trace_id)).toEqual(['old-3']);
    expect(await upgraded.migrations()).toEqual({ applied: KNOWN_MIGRATION_IDS.length, known: KNOWN_MIGRATION_IDS.length, pending: [] });
    await upgraded.close();
  });

  it('on a SQLite without FTS5, is recorded as applied and creates nothing', async () => {
    const path = tempDb();
    const store = new SqliteAdapter(path, { driver: SEARCH_DRIVER, fts5: false });
    await store.initialize();
    expect(await store.migrations()).toEqual({ applied: KNOWN_MIGRATION_IDS.length, known: KNOWN_MIGRATION_IDS.length, pending: [] });
    await store.close();
    const db = new Database(path, { readonly: true });
    expect(db.prepare(SEARCH_OBJECTS).all()).toEqual([]);
    db.close();
  });
});
