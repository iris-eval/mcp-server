import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT, asTenantId } from '../../../src/types/tenant.js';
import type { Span, Trace } from '../../../src/types/trace.js';

/*
 * The read behind the case-history rules: the runs of one case stored
 * before a given trace, from the short rows kept beside each trace
 * (migration 023). It runs for every evaluation of a trace that has a case,
 * so what is held here is that it reads the right runs, no more than it was
 * asked for, and nothing a deleted trace left behind.
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

const read = (traceId: string, timestamp = '2026-09-01T10:00:00Z', limit = 20, key = 'case-a') => store.getCaseHistory(LOCAL_TENANT, key, { traceId, timestamp }, limit);
const raw = () => (store as unknown as { db: { prepare(sql: string): { all(...params: unknown[]): Array<Record<string, unknown>>; run(...params: unknown[]): unknown } } }).db;

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
    expect((await read('t3')).map((r) => r.traceId)).toEqual(['t2', 't1']);
    expect((await read('t1')).map((r) => r.traceId)).toEqual([]);
    expect((await read('t4')).map((r) => r.traceId)).toEqual(['t3', 't2', 't1']);
  });

  it('carry what each run called and the specifics its answer carried, and nothing else of it', async () => {
    await store.insertTrace(LOCAL_TENANT, trace('t1', { case_key: 'case-a', tool_calls: [{ tool_name: 'get_balance' }, { tool_name: 'send_money', output: 'a secret tool output' }, { tool_name: 'get_balance' }] }));
    await store.insertTrace(LOCAL_TENANT, trace('t2', { case_key: 'case-a' }));
    expect(await read('t2')).toEqual([{ traceId: 't1', timestamp: '2026-09-01T10:00:00Z', tools: ['get_balance', 'send_money'], specifics: ['420', 'inv-7'] }]);
    const stored = JSON.stringify(raw().prepare('SELECT * FROM case_runs').all());
    expect(stored).not.toContain('secret tool output');
    expect(stored).not.toContain('Pay the open invoice');
  });

  it('read at most the limit, however often the case has been run', async () => {
    for (let i = 0; i < 30; i += 1) await store.insertTrace(LOCAL_TENANT, trace(`t${String(i).padStart(2, '0')}`, { case_key: 'case-a' }));
    expect((await read('t29', undefined, 5)).map((r) => r.traceId)).toEqual(['t28', 't27', 't26', 't25', 't24']);
  });

  it('a case derived from the input is a case like one the caller named', async () => {
    await store.insertTrace(LOCAL_TENANT, trace('t1'));
    await store.insertTrace(LOCAL_TENANT, trace('t2'));
    const stored = await store.getTrace(LOCAL_TENANT, 't2');
    expect(stored?.case_key).toMatch(/^[0-9a-f]{16}$/);
    expect((await read('t2', undefined, 20, stored!.case_key!)).map((r) => r.traceId)).toEqual(['t1']);
  });

  it('a trace with no case, neither a key nor an input, leaves no row', async () => {
    await store.insertTrace(LOCAL_TENANT, trace('t1', { input: undefined }));
    expect(raw().prepare('SELECT COUNT(*) AS n FROM case_runs').all()[0].n).toBe(0);
  });

  it('"before" is the order of storing, checked against the trace\'s own time: a run stored earlier and dated later is left out', async () => {
    await store.insertTrace(LOCAL_TENANT, trace('early', { case_key: 'case-a', timestamp: '2026-09-01T09:00:00Z' }));
    await store.insertTrace(LOCAL_TENANT, trace('dated-later', { case_key: 'case-a', timestamp: '2026-09-02T09:00:00Z' }));
    await store.insertTrace(LOCAL_TENANT, trace('now', { case_key: 'case-a', timestamp: '2026-09-01T10:00:00Z' }));
    expect((await read('now', '2026-09-01T10:00:00Z')).map((r) => r.traceId)).toEqual(['early']);
  });

  it('a run that sent no tool calls is read from the TOOL spans it was stored with; one that sent an empty list made none; one with neither recorded none', async () => {
    const span = (traceId: string): Span => ({ span_id: `s-${traceId}`, trace_id: traceId, name: 'send_money', kind: 'TOOL', status_code: 'OK', start_time: '2026-09-01T10:00:00Z', attributes: { 'tool.name': 'send_money' } });
    await store.insertTrace(LOCAL_TENANT, trace('spans', { case_key: 'case-a', tool_calls: undefined, spans: [span('spans')] }));
    await store.insertTrace(LOCAL_TENANT, trace('none', { case_key: 'case-a', tool_calls: undefined }));
    await store.insertTrace(LOCAL_TENANT, trace('empty', { case_key: 'case-a', tool_calls: [] }));
    await store.insertTrace(LOCAL_TENANT, trace('silent', { case_key: 'case-a', output: undefined }));
    await store.insertTrace(LOCAL_TENANT, trace('now', { case_key: 'case-a' }));
    const by = new Map((await read('now')).map((r) => [r.traceId, r]));
    expect(by.get('spans')?.tools).toEqual(['send_money']);
    expect(by.get('none')?.tools).toBeNull();
    expect(by.get('empty')?.tools).toEqual([]);
    expect(by.get('silent')?.specifics).toBeNull();
    expect(by.get('none')?.specifics).toEqual(['420', 'inv-7']);
  });

  it('a deleted trace takes its row with it, so nothing of its answer is read again', async () => {
    for (const id of ['t1', 't2', 't3']) await store.insertTrace(LOCAL_TENANT, trace(id, { case_key: 'case-a' }));
    expect(await store.deleteTrace(LOCAL_TENANT, 't2')).toBe(true);
    expect((await read('t3')).map((r) => r.traceId)).toEqual(['t1']);
    expect(raw().prepare('SELECT trace_id FROM case_runs ORDER BY trace_id').all().map((r) => r.trace_id)).toEqual(['t1', 't3']);
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
    expect((await read('mine-2')).map((r) => r.traceId)).toEqual(['mine-1']);
    // Asked as the other tenant for a trace that is not theirs: nothing.
    expect(await store.getCaseHistory(other, 'case-a', { traceId: 'mine-2', timestamp: '2026-09-01T10:00:00Z' }, 20)).toEqual([]);
  });

  it('a trace with no row of its own has no history: one stored before the rows were kept, or one that is not stored', async () => {
    for (const id of ['t1', 't2', 't3']) await store.insertTrace(LOCAL_TENANT, trace(id, { case_key: 'case-a' }));
    raw().prepare('DELETE FROM case_runs WHERE trace_id = ?').run('t3');
    expect(await read('t3')).toEqual([]);
    expect(await read('not-stored')).toEqual([]);
  });

  it('walks the case\'s index backwards from the trace: no scan of the table and no sort', async () => {
    const plan = raw()
      .prepare(
        `EXPLAIN QUERY PLAN SELECT c.trace_id AS trace_id, c.timestamp AS timestamp, c.tools AS tools, c.specifics AS specifics
           FROM case_runs c INDEXED BY idx_case_runs_tenant_case
          WHERE c.tenant_id = ? AND c.case_key = ? AND c.rowid < ?
          ORDER BY c.rowid DESC
          LIMIT ?`,
      )
      .all(LOCAL_TENANT, 'case-a', 100, 20)
      .map((r) => String(r.detail))
      .join(' | ');
    expect(plan).toContain('idx_case_runs_tenant_case');
    expect(plan).not.toMatch(/SCAN c\b/);
    expect(plan).not.toContain('TEMP B-TREE');
  });
});
