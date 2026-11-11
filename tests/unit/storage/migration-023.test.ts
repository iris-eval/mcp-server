/*
 * Migration 023 — what each run of a case did, kept small beside its trace.
 *
 *   - it is the last migration, after 022, and adds one table and one index;
 *   - a store that held traces before it keeps them, and they have no row:
 *     a case's history starts with the first run stored after the upgrade;
 *   - a writer that does not know the table can still store and delete
 *     (the floor's promise, held here with plain SQL standing in for it).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { COMPAT_FLOORS, KNOWN_MIGRATION_IDS } from '../../../src/storage/migrations/index.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const raw = (store: SqliteAdapter) => (store as unknown as { db: { prepare(sql: string): { all(...p: unknown[]): Array<Record<string, unknown>>; run(...p: unknown[]): unknown }; exec(sql: string): void } }).db;

describe('migration 023 — the runs of a case', () => {
  it('is the last known migration, after 022, with the floor 015 already holds', () => {
    expect(KNOWN_MIGRATION_IDS[KNOWN_MIGRATION_IDS.length - 1]).toBe('023-case-runs');
    expect(KNOWN_MIGRATION_IDS[KNOWN_MIGRATION_IDS.length - 2]).toBe('022-trace-capture');
    expect(COMPAT_FLOORS.get('023-case-runs')).toBe('0.20.0');
  });

  it('adds one table keyed by the trace, with the tenant on every row, and one index on the case and the agent', async () => {
    const store = new SqliteAdapter(':memory:');
    await store.initialize();
    const columns = raw(store).prepare('PRAGMA table_info(case_runs)').all();
    expect(columns.map((c) => [c.name, c.type, c.notnull, c.pk])).toEqual([
      ['trace_id', 'TEXT', 0, 1],
      ['tenant_id', 'TEXT', 1, 0],
      ['case_key', 'TEXT', 1, 0],
      ['agent_name', 'TEXT', 1, 0],
      ['tools', 'TEXT', 0, 0],
    ]);
    const fk = raw(store).prepare('PRAGMA foreign_key_list(case_runs)').all();
    expect(fk).toHaveLength(1);
    expect(fk[0]).toMatchObject({ table: 'traces', from: 'trace_id', to: 'trace_id', on_delete: 'CASCADE' });
    const index = raw(store).prepare("PRAGMA index_info('idx_case_runs_tenant_case_agent')").all();
    expect(index.map((c) => c.name)).toEqual(['tenant_id', 'case_key', 'agent_name']);
    await store.close();
  });

  it('a trace stored before it is kept and has no row; the first run stored after it starts the case\'s history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-mig023-'));
    dirs.push(dir);
    const path = join(dir, 'iris.db');
    const before = new SqliteAdapter(path);
    await before.initialize();
    // As the store looked before this migration: a trace of the case, no table, no ledger line.
    raw(before)
      .prepare('INSERT INTO traces (tenant_id, trace_id, agent_name, input, output, timestamp, case_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(LOCAL_TENANT, 'a'.repeat(32), 'bot', 'Pay the invoice.', 'Paid 420.', '2026-10-01T00:00:00.000Z', 'pay');
    raw(before).exec("DROP TABLE case_runs; DELETE FROM _iris_migrations WHERE id = '023-case-runs';");
    await before.close();

    const store = new SqliteAdapter(path);
    await store.initialize();
    expect(await store.migrations()).toEqual({ applied: KNOWN_MIGRATION_IDS.length, known: KNOWN_MIGRATION_IDS.length, pending: [] });
    expect((await store.getTrace(LOCAL_TENANT, 'a'.repeat(32)))?.output).toBe('Paid 420.');
    expect(raw(store).prepare('SELECT COUNT(*) AS n FROM case_runs').all()[0].n).toBe(0);
    await store.insertTrace(LOCAL_TENANT, { trace_id: 'b'.repeat(32), agent_name: 'bot', input: 'Pay the invoice.', output: 'Paid 420.', timestamp: '2026-11-10T00:00:00.000Z', case_key: 'pay' });
    await store.insertTrace(LOCAL_TENANT, { trace_id: 'c'.repeat(32), agent_name: 'bot', input: 'Pay the invoice.', output: 'Paid 420.', timestamp: '2026-11-10T00:00:01.000Z', case_key: 'pay' });
    // The run stored before the migration is not an earlier run; the one stored after it is.
    expect((await store.getCaseHistory(LOCAL_TENANT, 'c'.repeat(32), 20))?.map((r) => r.traceId)).toEqual(['b'.repeat(32)]);
    // And the old run itself, judged again, has no row of its own: no history, which is not an empty one.
    expect(await store.getCaseHistory(LOCAL_TENANT, 'a'.repeat(32), 20)).toBeNull();
    await store.close();
  });

  it('a writer that knows nothing of the table stores a trace and deletes one without breaking it (plain SQL standing in for a release from the floor on)', async () => {
    const store = new SqliteAdapter(':memory:');
    await store.initialize();
    await store.insertTrace(LOCAL_TENANT, { trace_id: 'd'.repeat(32), agent_name: 'bot', input: 'Pay the invoice.', output: 'Paid 420.', timestamp: '2026-11-10T00:00:00.000Z', case_key: 'pay' });
    // An older release's insert names no case_runs row, and its delete is a plain delete of the trace.
    raw(store)
      .prepare('INSERT INTO traces (tenant_id, trace_id, agent_name, input, output, timestamp, case_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(LOCAL_TENANT, 'e'.repeat(32), 'bot', 'Pay the invoice.', 'Paid 420.', '2026-11-10T00:00:01.000Z', 'pay');
    raw(store).prepare('DELETE FROM traces WHERE tenant_id = ? AND trace_id = ?').run(LOCAL_TENANT, 'd'.repeat(32));
    expect(raw(store).prepare('SELECT COUNT(*) AS n FROM case_runs').all()[0].n).toBe(0);
    expect((await store.getTrace(LOCAL_TENANT, 'e'.repeat(32)))?.case_key).toBe('pay');
    await store.close();
  });
});
