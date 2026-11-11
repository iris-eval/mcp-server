import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CASE_HISTORY_SQL, SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT, asTenantId } from '../../../src/types/tenant.js';
import type { Span, Trace } from '../../../src/types/trace.js';

/*
 * The read behind the case-history rules: the same agent's runs of the same
 * case stored before a given trace, from the short rows kept beside each
 * trace (migration 023). It runs for every evaluation of a trace that has a
 * case, so what is held here is that it reads the right runs, no more than
 * it was asked for, and nothing a deleted trace left behind.
 */

let dir: string;
let store: SqliteAdapter;

const trace = (id: string, over: Partial<Trace> = {}): Trace => ({
  trace_id: id,
  agent_name: 'runner',
  input: 'Pay the open invoice.',
  output: 'Paid 420.00 on INV-7.',
  tool_calls: [{ tool_name: 'send_money', input: { to: id }, output: 'ok' }],
  timestamp: '2026-09-01T10:00:00Z',
  ...over,
});

const read = async (traceId: string, limit = 20): Promise<string[] | null> => (await store.getCaseHistory(LOCAL_TENANT, traceId, limit))?.map((r) => r.traceId) ?? null;
const raw = (s: SqliteAdapter = store) => (s as unknown as { db: { prepare(sql: string): { all(...params: unknown[]): Array<Record<string, unknown>>; run(...params: unknown[]): unknown } } }).db;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'iris-case-history-'));
  store = new SqliteAdapter(join(dir, 'test.db'));
  await store.initialize();
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('the earlier runs of a case', () => {
  it('are the runs of that case stored before the trace, newest first, never the trace itself or a later one', async () => {
    for (const id of ['t1', 't2', 't3', 't4']) await store.insertTrace(LOCAL_TENANT, trace(id, { case_key: 'case-a' }));
    await store.insertTrace(LOCAL_TENANT, trace('other', { case_key: 'case-b' }));
    expect(await read('t3')).toEqual(['t2', 't1']);
    expect(await read('t1')).toEqual([]);
    expect(await read('t4')).toEqual(['t3', 't2', 't1']);
  });

  it('carry the tools each run called, and nothing else of it', async () => {
    await store.insertTrace(LOCAL_TENANT, trace('t1', { case_key: 'case-a', tool_calls: [{ tool_name: 'get_balance' }, { tool_name: 'send_money', input: { to: 'a secret argument' }, output: 'a secret tool output' }, { tool_name: 'get_balance' }] }));
    await store.insertTrace(LOCAL_TENANT, trace('t2', { case_key: 'case-a' }));
    expect(await store.getCaseHistory(LOCAL_TENANT, 't2', 20)).toEqual([{ traceId: 't1', tools: ['get_balance', 'send_money'] }]);
    const stored = JSON.stringify(raw().prepare('SELECT * FROM case_runs').all());
    for (const text of ['secret argument', 'secret tool output', 'Pay the open invoice', 'Paid 420.00']) expect(stored).not.toContain(text);
  });

  it('are the same agent\'s: one ask handed to two agents is one case key and two histories', async () => {
    for (const id of ['b1', 'b2', 'b3']) await store.insertTrace(LOCAL_TENANT, trace(id, { agent_name: 'billing-bot' }));
    await store.insertTrace(LOCAL_TENANT, trace('c1', { agent_name: 'calendar-bot' }));
    await store.insertTrace(LOCAL_TENANT, trace('b4', { agent_name: 'billing-bot' }));
    expect((await store.getTrace(LOCAL_TENANT, 'c1'))?.case_key).toBe((await store.getTrace(LOCAL_TENANT, 'b1'))?.case_key);
    expect(await read('c1')).toEqual([]);
    expect(await read('b4')).toEqual(['b3', 'b2', 'b1']);
  });

  it('read at most the limit, however often the case has been run', async () => {
    for (let i = 0; i < 30; i += 1) await store.insertTrace(LOCAL_TENANT, trace(`t${String(i).padStart(2, '0')}`, { case_key: 'case-a' }));
    expect(await read('t29', 5)).toEqual(['t28', 't27', 't26', 't25', 't24']);
  });

  it('a case derived from the input is a case like one the caller named; a trace with neither has no row and no history', async () => {
    await store.insertTrace(LOCAL_TENANT, trace('t1'));
    await store.insertTrace(LOCAL_TENANT, trace('t2'));
    expect((await store.getTrace(LOCAL_TENANT, 't2'))?.case_key).toMatch(/^[0-9a-f]{16}$/);
    expect(await read('t2')).toEqual(['t1']);
    await store.insertTrace(LOCAL_TENANT, trace('no-case', { input: undefined }));
    expect(raw().prepare('SELECT COUNT(*) AS n FROM case_runs').all()[0].n).toBe(2);
    expect(await read('no-case')).toBeNull();
    expect(await read('not-stored')).toBeNull();
  });

  it('"earlier" is the order of storing, whatever each trace\'s own timestamp says and however it is written', async () => {
    // Timestamps are the sender's: another zone, another precision, or a clock that ran ahead. Compared as text they misorder.
    await store.insertTrace(LOCAL_TENANT, trace('utc', { case_key: 'case-a', timestamp: '2026-09-01T10:00:24Z' }));
    await store.insertTrace(LOCAL_TENANT, trace('ahead', { case_key: 'case-a', timestamp: '2026-09-02T09:00:00Z' }));
    await store.insertTrace(LOCAL_TENANT, trace('millis', { case_key: 'case-a', timestamp: '2026-09-01T10:00:24.500Z' }));
    await store.insertTrace(LOCAL_TENANT, trace('offset', { case_key: 'case-a', timestamp: '2026-09-01T03:05:00-07:00' }));
    expect(await read('offset')).toEqual(['millis', 'ahead', 'utc']);
    expect(await read('millis')).toEqual(['ahead', 'utc']);
  });

  it('a run that sent no tool calls is read from the TOOL spans it was stored with; one that sent an empty list made none; one with neither recorded none', async () => {
    const span = (traceId: string): Span => ({ span_id: `s-${traceId}`, trace_id: traceId, name: 'send_money', kind: 'TOOL', status_code: 'OK', start_time: '2026-09-01T10:00:00Z', attributes: { 'tool.name': 'send_money' } });
    await store.insertTrace(LOCAL_TENANT, trace('spans', { case_key: 'case-a', tool_calls: undefined, spans: [span('spans')] }));
    await store.insertTrace(LOCAL_TENANT, trace('none', { case_key: 'case-a', tool_calls: undefined }));
    await store.insertTrace(LOCAL_TENANT, trace('empty', { case_key: 'case-a', tool_calls: [] }));
    await store.insertTrace(LOCAL_TENANT, trace('now', { case_key: 'case-a' }));
    const by = new Map((await store.getCaseHistory(LOCAL_TENANT, 'now', 20))!.map((r) => [r.traceId, r.tools]));
    expect(by.get('spans')).toEqual(['send_money']);
    expect(by.get('none')).toBeNull();
    expect(by.get('empty')).toEqual([]);
  });

  it('a deleted trace takes its row with it', async () => {
    for (const id of ['t1', 't2', 't3']) await store.insertTrace(LOCAL_TENANT, trace(id, { case_key: 'case-a' }));
    expect(await store.deleteTrace(LOCAL_TENANT, 't2')).toBe(true);
    expect(await read('t3')).toEqual(['t1']);
    expect(raw().prepare('SELECT trace_id FROM case_runs ORDER BY trace_id').all().map((r) => r.trace_id)).toEqual(['t1', 't3']);
  });

  it('a deleted trace leaves none of its row\'s bytes in the file or its log', async () => {
    /*
     * The search index is off here: what is asked is whether the row's own
     * bytes are gone, and the index is held to the same by
     * tests/unit/storage/erasure.test.ts.
     */
    const path = join(dir, 'erase.db');
    const plain = new SqliteAdapter(path, { searchIndex: 'off' });
    await plain.initialize();
    const name = 'export_records_qx7zebraquokka42';
    const holds = (needle: string): boolean => [path, `${path}-wal`].some((f) => existsSync(f) && readFileSync(f).includes(Buffer.from(needle, 'utf8')));
    try {
      await plain.insertTrace(LOCAL_TENANT, trace('keep', { case_key: 'case-a' }));
      await plain.insertTrace(LOCAL_TENANT, trace('gone', { case_key: 'case-a', tool_calls: [{ tool_name: name }] }));
      await plain.checkpoint();
      expect(raw(plain).prepare('SELECT tools FROM case_runs WHERE trace_id = ?').all('gone')[0].tools).toContain(name);
      expect(holds(name)).toBe(true);
      expect(await plain.deleteTrace(LOCAL_TENANT, 'gone')).toBe(true);
      expect(holds(name)).toBe(false);
    } finally {
      await plain.close();
    }
  });

  it('the retention sweep takes the rows of the traces it deletes', async () => {
    await store.insertTrace(LOCAL_TENANT, trace('old', { case_key: 'case-a', timestamp: '2020-01-01T00:00:00Z' }));
    await store.insertTrace(LOCAL_TENANT, trace('new', { case_key: 'case-a', timestamp: new Date().toISOString() }));
    await store.deleteTracesOlderThan(LOCAL_TENANT, 30);
    expect(raw().prepare('SELECT trace_id FROM case_runs').all().map((r) => r.trace_id)).toEqual(['new']);
  });

  it('never reads another tenant\'s runs of the same case', async () => {
    const other = asTenantId('other-team');
    await store.insertTrace(other, trace('theirs', { case_key: 'case-a' }));
    await store.insertTrace(LOCAL_TENANT, trace('mine-1', { case_key: 'case-a' }));
    await store.insertTrace(LOCAL_TENANT, trace('mine-2', { case_key: 'case-a' }));
    expect(await read('mine-2')).toEqual(['mine-1']);
    // Asked as the other tenant for a trace that is not theirs: no row, so no history.
    expect(await store.getCaseHistory(other, 'mine-2', 20)).toBeNull();
  });

  it('walks the case\'s index backwards from the trace: no scan of the table and no sort', async () => {
    // The adapter's own statement, not a copy of it.
    const plan = raw()
      .prepare(`EXPLAIN QUERY PLAN ${CASE_HISTORY_SQL}`)
      .all(LOCAL_TENANT, 'case-a', 'runner', 100, 20)
      .map((r) => String(r.detail))
      .join(' | ');
    expect(plan).toContain('idx_case_runs_tenant_case_agent');
    expect(plan).not.toMatch(/SCAN c\b/);
    expect(plan).not.toContain('TEMP B-TREE');
  });
});
