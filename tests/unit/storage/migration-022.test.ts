/*
 * Migration 022 — the capture source's declaration on a trace.
 *
 *   - it is the last migration, after 021, and adds one nullable column;
 *   - a trace stored before it (the column NULL) reads back with no
 *     declaration, and is judged as it always was: nobody declared;
 *   - a trace stored after it keeps the declaration it was sent with.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { COMPAT_FLOORS, KNOWN_MIGRATION_IDS } from '../../../src/storage/migrations/index.js';
import { recordOfTrace } from '../../../src/eval/evidence.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const raw = (store: SqliteAdapter) => (store as unknown as { db: { prepare(sql: string): { all(...p: unknown[]): Array<Record<string, unknown>>; run(...p: unknown[]): unknown } } }).db;

describe('migration 022 — the capture source on a trace', () => {
  it('is the last known migration, after 021, with the floor 015 already holds', () => {
    expect(KNOWN_MIGRATION_IDS[KNOWN_MIGRATION_IDS.length - 1]).toBe('022-trace-capture');
    expect(KNOWN_MIGRATION_IDS[KNOWN_MIGRATION_IDS.length - 2]).toBe('021-eval-verdict-state');
    expect(COMPAT_FLOORS.get('022-trace-capture')).toBe('0.20.0');
  });

  it('adds one nullable column to traces', async () => {
    const store = new SqliteAdapter(':memory:');
    await store.initialize();
    const capture = raw(store).prepare('PRAGMA table_info(traces)').all().find((c) => c.name === 'capture');
    expect(capture).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
    await store.close();
  });

  it('a trace written without the column reads back as nobody having declared; one written with it keeps the declaration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-mig022-'));
    dirs.push(dir);
    const store = new SqliteAdapter(join(dir, 'iris.db'));
    await store.initialize();
    // As a release before 0.20.0 writes a row: its insert names no capture column.
    raw(store)
      .prepare('INSERT INTO traces (tenant_id, trace_id, agent_name, output, timestamp, source) VALUES (?, ?, ?, ?, ?, ?)')
      .run(LOCAL_TENANT, 'e'.repeat(32), 'bot', 'x', '2026-10-01T00:00:00.000Z', 'hook');
    const earlier = (await store.getTrace(LOCAL_TENANT, 'e'.repeat(32)))!;
    expect(earlier.capture).toBeUndefined();
    expect(recordOfTrace(earlier)).toEqual({ recordedBy: 'not_declared' });
    const declared = { name: 'iris-eval-capture', version: '0.20.0', complete: ['tool_calls' as const] };
    await store.insertTrace(LOCAL_TENANT, { trace_id: 'f'.repeat(32), agent_name: 'claude-code', output: 'x', timestamp: '2026-10-03T00:00:00.000Z', source: 'hook', capture: declared });
    expect((await store.getTrace(LOCAL_TENANT, 'f'.repeat(32)))?.capture).toEqual(declared);
    await store.close();
  });
});
