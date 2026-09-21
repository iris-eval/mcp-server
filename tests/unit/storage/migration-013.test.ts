/*
 * Migration 013 — the pinned baseline (arc 9, N-14).
 *
 * The column it adds, applied once on a cold file beside 001–012 and on a
 * database written before it; the partial unique index that makes "at most
 * one baseline per tenant" a fact of the schema; and the count of known
 * migrations, which the newest migration's test owns.
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
  const dir = mkdtempSync(join(tmpdir(), 'iris-mig013-'));
  dirs.push(dir);
  return join(dir, 'iris.db');
}

describe('migration 013 — the pinned baseline', () => {
  it('is the thirteenth known migration, and the last', () => {
    expect(KNOWN_MIGRATION_IDS).toHaveLength(13);
    expect(KNOWN_MIGRATION_IDS[12]).toBe('013-run-baseline');
  });

  it('adds runs.baseline (default 0) and the partial unique index on a cold file, once, and re-opens unchanged', async () => {
    const path = tempDb();
    const store = new SqliteAdapter(path);
    await store.initialize();
    await store.close();
    const db = new Database(path, { readonly: true });
    const runs = db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
    const baseline = runs.find((c) => c.name === 'baseline');
    expect(baseline).toMatchObject({ notnull: 1, dflt_value: '0' });
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(indexes).toContain('idx_runs_baseline');
    const applied = (db.prepare('SELECT id FROM _iris_migrations ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
    expect(applied).toEqual([...KNOWN_MIGRATION_IDS]);
    expect(applied.filter((id) => id === '013-run-baseline')).toHaveLength(1);
    db.close();
    const again = new SqliteAdapter(path);
    await again.initialize();
    expect((await again.migrations()).pending).toEqual([]);
    await again.close();
  });

  it('a database written before 013 gains the column with every existing run unpinned', async () => {
    const path = tempDb();
    const store = new SqliteAdapter(path);
    await store.initialize();
    await store.close();
    // Roll the file back to the 012 shape: drop the column and the row that says 013 ran.
    const db = new Database(path);
    db.exec("DROP INDEX idx_runs_baseline; ALTER TABLE runs DROP COLUMN baseline; DELETE FROM _iris_migrations WHERE id = '013-run-baseline'");
    db.prepare("INSERT INTO runs (run_id, tenant_id, label) VALUES ('old-1', ?, 'before 013')").run(LOCAL_TENANT);
    db.close();
    const upgraded = new SqliteAdapter(path);
    await upgraded.initialize();
    expect((await upgraded.migrations()).pending).toEqual([]);
    const listed = await upgraded.listRuns(LOCAL_TENANT, 10);
    expect(listed.find((r) => r.runId === 'old-1')).toMatchObject({ baseline: false });
    expect(await upgraded.getBaselineRun(LOCAL_TENANT)).toBeNull();
    await upgraded.close();
  });

  it('the index refuses a second baseline in one tenant and allows one per tenant', async () => {
    const path = tempDb();
    const store = new SqliteAdapter(path);
    await store.initialize();
    await store.close();
    const db = new Database(path);
    const insert = db.prepare('INSERT INTO runs (run_id, tenant_id, baseline) VALUES (?, ?, ?)');
    insert.run('r1', 't1', 1);
    insert.run('r2', 't1', 0);
    insert.run('r3', 't2', 1);
    expect(() => insert.run('r4', 't1', 1)).toThrow(/UNIQUE constraint failed/);
    expect((db.prepare('SELECT count(*) AS n FROM runs WHERE baseline = 1').get() as { n: number }).n).toBe(2);
    db.close();
  });
});
