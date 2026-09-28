/*
 * exportTraces and exportEvalResults (#4): an export holds exactly the
 * rows the list would page through with the same filters and search, in
 * the same order, each trace with its spans and evaluations; never another
 * tenant's; a batch at a time; and fixed at the moment it starts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT, asTenantId, type TenantId } from '../../../src/types/tenant.js';
import type { TraceExportOptions, TraceRecord } from '../../../src/types/query.js';
import type { EvalResult } from '../../../src/types/eval.js';
import { SEARCH_DRIVER } from './fts5-here.js';

const open: SqliteAdapter[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
});

async function adapter(options: { fts5?: boolean } = {}): Promise<SqliteAdapter> {
  const s = new SqliteAdapter(':memory:', { driver: SEARCH_DRIVER, ...options });
  await s.initialize();
  open.push(s);
  await s.whenSearchIndexReady();
  return s;
}

const at = (minute: number) => new Date(Date.UTC(2026, 8, 20, 12, minute)).toISOString();
const OTHER = asTenantId('tenant-b');

/** Twelve traces over two agents, some mentioning refunds, some with spans and evaluations; the same shape again under another tenant. */
async function seed(s: SqliteAdapter, tenant: TenantId = LOCAL_TENANT, prefix = 'a'): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const id = `${prefix}${String(i).padStart(2, '0')}`;
    await s.insertTrace(tenant, {
      trace_id: id,
      agent_name: i % 2 === 0 ? 'support-bot' : 'sales-bot',
      input: i % 3 === 0 ? `refund request ${i}` : `question ${i}`,
      output: i % 4 === 0 ? 'refund approved, refund issued' : `answer ${i}`,
      latency_ms: (i * 37) % 11,
      cost_usd: i % 5 === 0 ? undefined : i / 1000,
      timestamp: at(i % 7), // ties on purpose
    });
    if (i % 2 === 0) {
      await s.insertSpan(tenant, { span_id: `${id}-s1`, trace_id: id, name: 'llm', kind: 'LLM', status_code: 'OK', start_time: at(i % 7) });
    }
    if (i % 3 !== 2) {
      await s.insertEvalResult(tenant, { id: `${id}-e1`, trace_id: id, eval_type: 'completeness', output_text: 'x', score: 0.2, passed: false, rule_results: [], created_at: at(20 + i) });
      await s.insertEvalResult(tenant, { id: `${id}-e2`, trace_id: id, eval_type: 'safety', output_text: 'x', score: (i % 10) / 10, passed: i % 2 === 0, rule_results: [], created_at: at(40 + i) });
    }
  }
}

async function collect<T>(gen: AsyncGenerator<T[]>): Promise<{ rows: T[]; batches: number[] }> {
  const rows: T[] = [];
  const batches: number[] = [];
  for await (const batch of gen) {
    batches.push(batch.length);
    rows.push(...batch);
  }
  return { rows, batches };
}

/** What the list shows for the same options, every page of it. */
async function listed(s: SqliteAdapter, options: TraceExportOptions, tenant: TenantId = LOCAL_TENANT): Promise<string[]> {
  const out: string[] = [];
  for (let offset = 0; ; offset += 5) {
    const page = await s.queryTraces(tenant, { ...options, limit: 5, offset });
    out.push(...page.traces.map((t) => t.trace_id));
    if (offset + 5 >= page.total) return out;
  }
}

const QUERIES: Array<[string, TraceExportOptions]> = [
  ['no filter', {}],
  ['agent', { filter: { agent_name: 'support-bot' } }],
  ['window', { filter: { since: at(2), until: at(5) } }],
  ['latest score', { filter: { min_score: 0.3, max_score: 0.8 } }],
  ['latency ascending', { sort_by: 'latency_ms', sort_order: 'asc' }],
  ['cost descending (with nulls)', { sort_by: 'cost_usd', sort_order: 'desc' }],
  ['search, by relevance', { search: 'refund' }],
  ['search, filtered, by time', { search: 'refund', filter: { agent_name: 'support-bot' }, sort_by: 'timestamp', sort_order: 'asc' }],
];

describe('exportTraces', () => {
  for (const [name, options] of QUERIES) {
    it(`holds the same traces as the list pages, in the same order: ${name}`, async () => {
      const s = await adapter();
      await seed(s);
      const { rows } = await collect(s.exportTraces(LOCAL_TENANT, options, 4));
      const expected = await listed(s, options);
      expect(new Set(rows.map((r) => r.trace.trace_id))).toEqual(new Set(expected));
      expect(rows, 'no trace twice, none missed').toHaveLength(expected.length);
      // Ties (equal timestamps, equal nulls) may be broken either way by the list, which has no tie-break; the sort key's order must match.
      const key = (id: string, r: TraceRecord[]) => {
        const t = r.find((x) => x.trace.trace_id === id)!.trace;
        return options.sort_by === 'latency_ms' ? t.latency_ms : options.sort_by === 'cost_usd' ? t.cost_usd ?? null : options.search && !options.sort_by ? null : t.timestamp;
      };
      const exportedKeys = rows.map((r) => key(r.trace.trace_id, rows));
      const listedKeys = expected.map((id) => key(id, rows));
      expect(exportedKeys).toEqual(listedKeys);
      if (options.search && !options.sort_by) expect(rows.map((r) => r.trace.trace_id)).toEqual(expected);
    });
  }

  it('reads in time order a batch at a time without repeating or skipping a trace when many share a timestamp', async () => {
    const s = await adapter();
    // 23 traces over 3 timestamps, so every batch boundary of 2 or 5 falls inside a run of equal times.
    await s.insertTraces(LOCAL_TENANT, Array.from({ length: 23 }, (_, i) => ({ trace_id: `t${String(i).padStart(2, '0')}`, agent_name: 'bot', timestamp: at(i % 3) })));
    for (const sort_order of ['asc', 'desc'] as const) {
      for (const size of [1, 2, 5, 23, 50]) {
        const { rows } = await collect(s.exportTraces(LOCAL_TENANT, { sort_by: 'timestamp', sort_order }, size));
        const ids = rows.map((r) => r.trace.trace_id);
        expect(new Set(ids).size, `${sort_order} by ${size}`).toBe(23);
        expect(ids, `${sort_order} by ${size}`).toHaveLength(23);
        const times = rows.map((r) => r.trace.timestamp);
        expect(times).toEqual([...times].sort((a, b) => (sort_order === 'asc' ? a.localeCompare(b) : b.localeCompare(a))));
      }
    }
    const evals = Array.from({ length: 17 }, (_, i) => ({ id: `e${String(i).padStart(2, '0')}`, eval_type: 'safety' as const, output_text: 'x', score: 1, passed: true, rule_results: [], created_at: at(i % 2) }));
    for (const e of evals) await s.insertEvalResult(LOCAL_TENANT, e);
    for (const size of [1, 3, 17]) {
      const { rows } = await collect(s.exportEvalResults(LOCAL_TENANT, {}, size));
      expect(new Set(rows.map((e) => e.id)).size).toBe(17);
      expect(rows).toHaveLength(17);
    }
  });

  it('searches the same without the full-text index', async () => {
    const indexed = await adapter();
    const scanned = await adapter({ fts5: false });
    await seed(indexed);
    await seed(scanned);
    const a = await collect(indexed.exportTraces(LOCAL_TENANT, { search: 'refund', sort_by: 'timestamp' }));
    const b = await collect(scanned.exportTraces(LOCAL_TENANT, { search: 'refund', sort_by: 'timestamp' }));
    expect(b.rows.map((r) => r.trace.trace_id)).toEqual(a.rows.map((r) => r.trace.trace_id));
    expect(a.rows.length).toBeGreaterThan(0);
  });

  it('carries each trace with its spans and its evaluations newest first — the trace-detail shape', async () => {
    const s = await adapter();
    await seed(s);
    const { rows } = await collect(s.exportTraces(LOCAL_TENANT, {}));
    const a00 = rows.find((r) => r.trace.trace_id === 'a00')!;
    expect(a00.spans.map((x) => x.span_id)).toEqual(['a00-s1']);
    expect(a00.evals.map((e) => e.id)).toEqual(['a00-e2', 'a00-e1']);
    expect(a00).toEqual({ trace: await s.getTrace(LOCAL_TENANT, 'a00'), spans: await s.getSpansByTraceId(LOCAL_TENANT, 'a00'), evals: await s.getEvalsByTraceId(LOCAL_TENANT, 'a00') });
    const a02 = rows.find((r) => r.trace.trace_id === 'a02')!;
    expect(a02.evals).toEqual([]);
    expect(rows.find((r) => r.trace.trace_id === 'a01')!.spans).toEqual([]);
  });

  it('never yields another tenant’s trace, span or evaluation, even under the same ids and words', async () => {
    const s = await adapter();
    await seed(s, LOCAL_TENANT, 'a');
    await seed(s, OTHER, 'b');
    for (const options of [{}, { search: 'refund' }, { filter: { min_score: 0 } }] as TraceExportOptions[]) {
      const mine = await collect(s.exportTraces(LOCAL_TENANT, options));
      const theirs = await collect(s.exportTraces(OTHER, options));
      expect(mine.rows.length).toBeGreaterThan(0);
      expect(mine.rows.every((r) => r.trace.trace_id.startsWith('a') && r.spans.every((x) => x.trace_id.startsWith('a')) && r.evals.every((e) => e.id.startsWith('a')))).toBe(true);
      expect(theirs.rows.every((r) => r.trace.trace_id.startsWith('b') && r.evals.every((e) => e.id.startsWith('b')))).toBe(true);
    }
  });

  it('reads batchSize traces per batch', async () => {
    const s = await adapter();
    await seed(s);
    expect((await collect(s.exportTraces(LOCAL_TENANT, {}, 5))).batches).toEqual([5, 5, 2]);
    expect((await collect(s.exportTraces(LOCAL_TENANT, { filter: { agent_name: 'nobody' } }))).batches).toEqual([]);
  });

  it('is fixed when it starts: a trace deleted part-way is skipped, one stored part-way is not added', async () => {
    const s = await adapter();
    await seed(s);
    const gen = s.exportTraces(LOCAL_TENANT, { sort_by: 'timestamp', sort_order: 'asc' }, 4);
    const first = await gen.next();
    const seen = new Set((first.value as TraceRecord[]).map((r) => r.trace.trace_id));
    const all = await listed(s, { sort_by: 'timestamp', sort_order: 'asc' });
    const victim = all.find((id) => !seen.has(id))!;
    await s.deleteTrace(LOCAL_TENANT, victim);
    await s.insertTrace(LOCAL_TENANT, { trace_id: 'late', agent_name: 'support-bot', timestamp: at(59) });
    const rest = await collect(gen);
    const ids = [...seen, ...rest.rows.map((r) => r.trace.trace_id)];
    expect(ids).not.toContain(victim);
    expect(ids).not.toContain('late');
    expect(ids).toHaveLength(11);
  });

  it('refuses relevance without a search, as the list does', async () => {
    const s = await adapter();
    await expect(s.exportTraces(LOCAL_TENANT, { sort_by: 'relevance' }).next()).rejects.toThrow(/relevance ranks a search/);
  });
});

describe('exportEvalResults', () => {
  it('holds what the list pages hold, newest first, with the same filters, never another tenant’s', async () => {
    const s = await adapter();
    await seed(s, LOCAL_TENANT, 'a');
    await seed(s, OTHER, 'b');
    for (const filter of [{}, { eval_type: 'safety' }, { passed: false }, { since: at(25), until: at(45) }]) {
      const { rows } = await collect(s.exportEvalResults(LOCAL_TENANT, filter, 3));
      const page = await s.queryEvalResults(LOCAL_TENANT, { ...filter, limit: 1000 });
      expect(rows.map((e: EvalResult) => e.id)).toEqual(page.results.map((e) => e.id));
      expect(rows.every((e) => e.id.startsWith('a'))).toBe(true);
    }
  });
});
