/*
 * Migration 020: `eval_results.reference_trace_id`, the trace an evaluation
 * was made beside when it is not that trace's verdict.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { KNOWN_MIGRATION_IDS } from '../../../src/storage/migrations/index.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import type { EvalResult } from '../../../src/types/eval.js';

const stores: SqliteAdapter[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});
async function store(): Promise<SqliteAdapter> {
  const s = new SqliteAdapter(':memory:');
  await s.initialize();
  stores.push(s);
  return s;
}

const evaluation = (id: string, over: Partial<EvalResult>): EvalResult =>
  ({ id, eval_type: 'all', output_text: 'text', score: 1, passed: true, rule_results: [{ ruleName: 'non_empty_output', passed: true, score: 1, message: 'ok' }], ...over }) as EvalResult;

describe('migration 020 — evaluations made beside a trace', () => {
  it('is the twentieth migration, after 019', () => {
    expect(KNOWN_MIGRATION_IDS[19]).toBe('020-eval-reference-trace');
    expect(KNOWN_MIGRATION_IDS[18]).toBe('019-read-paths');
  });

  it('adds the column and an index that holds only the rows that carry one', async () => {
    const s = await store();
    const db = (s as unknown as { db: { prepare(sql: string): { all(): Array<Record<string, unknown>> } } }).db;
    const columns = db.prepare('PRAGMA table_info(eval_results)').all().map((c) => c.name);
    expect(columns).toContain('reference_trace_id');
    const index = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_eval_results_tenant_reference'").all();
    expect(String(index[0]?.sql)).toMatch(/WHERE reference_trace_id IS NOT NULL/);
  });

  it('a row is a verdict or sits beside a trace, never both, and reads back as it was written', async () => {
    const s = await store();
    await s.insertTrace(LOCAL_TENANT, { trace_id: 't1', agent_name: 'a', input: 'q', output: 'text', timestamp: '2026-10-02T10:00:00.000Z' });
    await s.insertEvalResult(LOCAL_TENANT, evaluation('verdict', { trace_id: 't1', created_at: '2026-10-02T10:00:01.000Z' }));
    await s.insertEvalResult(LOCAL_TENANT, evaluation('beside', { reference_trace_id: 't1', created_at: '2026-10-02T10:00:02.000Z' }));
    // Both set is a caller's mistake; the verdict column wins and the row is not also a reference.
    await s.insertEvalResult(LOCAL_TENANT, evaluation('both', { trace_id: 't1', reference_trace_id: 't1', created_at: '2026-10-02T10:00:03.000Z' }));

    const beside = await s.getEvalById(LOCAL_TENANT, 'beside');
    expect(beside?.reference_trace_id).toBe('t1');
    expect(beside?.trace_id ?? null).toBeNull();
    expect((await s.getEvalById(LOCAL_TENANT, 'both'))?.reference_trace_id).toBeUndefined();
    expect((await s.getEvalById(LOCAL_TENANT, 'verdict'))?.reference_trace_id).toBeUndefined();

    // Listed together, newest first.
    expect((await s.getEvalsByTraceId(LOCAL_TENANT, 't1')).map((e) => e.id)).toEqual(['both', 'beside', 'verdict']);
    expect([...(await s.getEvalsByTraceIds(LOCAL_TENANT, ['t1'])).get('t1')!].map((e) => e.id)).toEqual(['both', 'beside', 'verdict']);
  });

  it('a trace with only an evaluation beside it is still listed with it', async () => {
    const s = await store();
    await s.insertTrace(LOCAL_TENANT, { trace_id: 't2', agent_name: 'a', input: 'q', timestamp: '2026-10-02T10:00:00.000Z' });
    await s.insertEvalResult(LOCAL_TENANT, evaluation('only-beside', { reference_trace_id: 't2' }));
    expect((await s.getEvalsByTraceId(LOCAL_TENANT, 't2')).map((e) => e.id)).toEqual(['only-beside']);
    expect([...(await s.getEvalsByTraceIds(LOCAL_TENANT, ['t2', 'nope'])).keys()]).toEqual(['t2']);
  });
});
