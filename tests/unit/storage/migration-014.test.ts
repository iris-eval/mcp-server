/*
 * Migration 014 — the trace's session.
 *
 * The column and the index it adds, applied once on a cold file and on a
 * database written before it; the session stored and read back through the
 * adapter and filtered on the index.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { KNOWN_MIGRATION_IDS } from '../../../src/storage/migrations/index.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iris-mig014-'));
  dirs.push(dir);
  return join(dir, 'iris.db');
}

const trace = (id: string, session?: string, timestamp = '2026-09-21T12:00:00.000Z') => ({
  trace_id: id,
  agent_name: 'bot',
  input: `ask ${id}`,
  output: 'o',
  timestamp,
  ...(session ? { session_id: session } : {}),
});

describe('migration 014 — the trace session', () => {
  it('is the fourteenth known migration', () => {
    // The newest migration's test owns the count; this one owns the position.
    expect(KNOWN_MIGRATION_IDS[13]).toBe('014-trace-session');
    expect(KNOWN_MIGRATION_IDS[12]).toBe('013-run-baseline');
  });

  it('adds traces.session_id and its index on a cold file, once, and re-opens unchanged', async () => {
    const path = tempDb();
    const store = new SqliteAdapter(path);
    await store.initialize();
    await store.close();
    const db = new Database(path, { readonly: true });
    const columns = (db.prepare('PRAGMA table_info(traces)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain('session_id');
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(indexes).toContain('idx_traces_tenant_session');
    const applied = (db.prepare('SELECT id FROM _iris_migrations ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
    expect(applied).toEqual([...KNOWN_MIGRATION_IDS]);
    expect(applied.filter((id) => id === '014-trace-session')).toHaveLength(1);
    db.close();
    const again = new SqliteAdapter(path);
    await again.initialize();
    expect((await again.migrations()).pending).toEqual([]);
    await again.close();
  });

  it('a database written before 014 gains the column with every existing trace outside any session', async () => {
    const path = tempDb();
    const store = new SqliteAdapter(path);
    await store.initialize();
    await store.insertTrace(LOCAL_TENANT, trace('old-1'));
    await store.close();
    // Roll the file back to the 013 shape: undo 015 (the search index, which reads session_id), then drop the index, the column and the rows that say 014 and 015 ran.
    const db = new Database(path);
    db.exec(
      'DROP TRIGGER trace_search_au; DROP TRIGGER trace_search_ad; DROP TABLE trace_search; DROP TABLE trace_search_docs; DROP INDEX idx_traces_search_filter; ' +
        "DROP INDEX idx_traces_tenant_session; ALTER TABLE traces DROP COLUMN session_id; DELETE FROM _iris_migrations WHERE id IN ('014-trace-session', '015-trace-search')",
    );
    db.close();
    const upgraded = new SqliteAdapter(path);
    await upgraded.initialize();
    expect((await upgraded.migrations()).pending).toEqual([]);
    expect((await upgraded.getTrace(LOCAL_TENANT, 'old-1'))?.session_id).toBeUndefined();
    await upgraded.insertTrace(LOCAL_TENANT, trace('new-1', 'sess-1'));
    expect((await upgraded.getTrace(LOCAL_TENANT, 'new-1'))?.session_id).toBe('sess-1');
    await upgraded.close();
  });

  it('the session round-trips, filters in time order, and stays out of a trace logged without one', async () => {
    const store = new SqliteAdapter(':memory:');
    await store.initialize();
    try {
      await store.insertTrace(LOCAL_TENANT, trace('t2', 'sess-1', '2026-09-21T12:01:00.000Z'));
      await store.insertTrace(LOCAL_TENANT, trace('t1', 'sess-1', '2026-09-21T12:00:00.000Z'));
      await store.insertTrace(LOCAL_TENANT, trace('t3', 'sess-2'));
      await store.insertTrace(LOCAL_TENANT, trace('t4'));
      const page = await store.queryTraces(LOCAL_TENANT, { filter: { session_id: 'sess-1' }, sort_by: 'timestamp', sort_order: 'asc' });
      expect(page.total).toBe(2);
      expect(page.traces.map((t) => t.trace_id)).toEqual(['t1', 't2']);
      expect(page.traces.every((t) => t.session_id === 'sess-1')).toBe(true);
      expect((await store.queryTraces(LOCAL_TENANT, { filter: { session_id: 'sess-9' } })).total).toBe(0);
      expect((await store.getTrace(LOCAL_TENANT, 't4'))?.session_id).toBeUndefined();
      expect((await store.queryTraces(LOCAL_TENANT, {})).total).toBe(4);
    } finally {
      await store.close();
    }
  });
});
