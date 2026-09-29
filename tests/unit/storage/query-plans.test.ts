/*
 * The query plan of every hot read (#711).
 *
 * 0.20.0's covering search index changed SQLite's plan for the agent
 * failure log — the read behind every evaluation's cost baseline — from
 * 0.6 ms to 339 ms at 100,000 traces, and nothing noticed: the answer was
 * the same, only the plan moved. The hot reads now name their index and
 * fix their join order, and this file holds them there. Each read below
 * runs through the adapter; every statement it issues is explained with
 * the parameters it ran with, and the plan must:
 *
 *   - use every index the statement names (SQLite refuses to prepare a
 *     statement whose named index it cannot use, which fails here too);
 *   - never read the whole traces, eval_results or spans table;
 *   - for each join, start from the table the read is designed to start
 *     from and find the other side through the index it is designed for.
 *
 * On both drivers (node:sqlite where this Node has it), with the search
 * index and without it (a SQLite without FTS5 has no covering search
 * index), and under four sets of statistics: none (every store Iris writes;
 * it never runs ANALYZE, see sqlite-adapter.ts), ANALYZE of the test data,
 * and the sqlite_stat1 that ANALYZE wrote for two 100,000-trace stores —
 * every trace evaluated, and one in a hundred. The last two are the
 * statistics under which SQLite chose the slow plans before.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter, RISK_FILL_QUERIES } from '../../../src/storage/sqlite-adapter.js';
import { RISK_KEY_VERSION } from '../../../src/eval/risk.js';
import { nodeSqliteAvailable, type Driver, type Statement } from '../../../src/storage/driver.js';
import { LOCAL_TENANT, asTenantId } from '../../../src/types/tenant.js';
import type { Trace } from '../../../src/types/trace.js';
import { driverHasFts5 } from './fts5-here.js';

vi.setConfig({ testTimeout: 60_000 });

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/* ---- The store every variant reads ---- */

const OTHER = asTenantId('other-tenant');
const BASE = Date.parse('2026-09-01T00:00:00.000Z');
/** Four traces share each timestamp, so ties are everywhere. */
const at = (i: number) => new Date(BASE + Math.floor(i / 4) * 60_000).toISOString();

/*
 * a0: 100 traces, every one evaluated (the failure log walks its traces);
 * a1: 100 traces, one in ten evaluated;
 * a2: 300 traces, one in fifteen evaluated — more traces than the tenant
 *     has evaluations (the failure log reads the evaluations).
 */
const AGENTS: Array<{ name: string; traces: number; every: number }> = [
  { name: 'a0', traces: 100, every: 1 },
  { name: 'a1', traces: 100, every: 10 },
  { name: 'a2', traces: 300, every: 15 },
];

async function seed(store: SqliteAdapter): Promise<void> {
  let n = 0;
  for (const agent of AGENTS) {
    const batch: Trace[] = [];
    for (let k = 0; k < agent.traces; k++, n++) {
      batch.push({
        trace_id: `${agent.name}-${k}`,
        agent_name: agent.name,
        framework: k % 3 === 0 ? 'langchain' : k % 3 === 1 ? 'autogen' : undefined,
        input: `order ${k} for ${agent.name}`,
        output: k % 2 ? `The refund for order ${k} was approved.` : `Order ${k} shipped on time.`,
        latency_ms: 100 + (k % 50),
        cost_usd: 0.001 * (k % 7),
        timestamp: at(n),
        ...(k % 5 === 0 ? { session_id: `s-${k % 20}` } : {}),
        ...(k % 4 === 0 ? { case_key: `case-${k % 8}` } : {}),
        ...(k % 6 === 0
          ? { spans: [{ span_id: `${agent.name}-${k}-s`, trace_id: `${agent.name}-${k}`, name: 'call', kind: 'LLM', status_code: k % 12 === 0 ? 'ERROR' : 'OK', start_time: at(n) }] }
          : {}),
      } as Trace);
    }
    await store.insertTraces(LOCAL_TENANT, batch);
    for (let k = 0; k < agent.traces; k += agent.every) {
      await store.insertEvalResult(LOCAL_TENANT, {
        id: `e-${agent.name}-${k}`,
        trace_id: `${agent.name}-${k}`,
        eval_type: 'completeness',
        output_text: 'x',
        score: (k % 10) / 10,
        passed: k % 2 === 0,
        rule_results: [{ ruleName: 'min_output_length', passed: k % 2 === 0, score: 1, message: '' }],
        created_at: new Date(BASE + k * 1000).toISOString(),
      });
    }
  }
  // Another tenant's rows, so a read that forgot the tenant would show it.
  await store.insertTraces(OTHER, [{ trace_id: 'o-1', agent_name: 'a0', output: 'refund', timestamp: at(0) }]);
}

/* ---- Statistics ---- */

type StatRow = [table: string, index: string, stat: string];
/** sqlite_stat1 as ANALYZE wrote it for a 100,000-trace store with every trace evaluated. */
const DENSE_100K: StatRow[] = [
  ['eval_results', 'idx_eval_results_created_at', '100000 1'],
  ['eval_results', 'idx_eval_results_eval_type', '100000 100000'],
  ['eval_results', 'idx_eval_results_passed', '100000 100000'],
  ['eval_results', 'idx_eval_results_tenant_created', '100000 100000 1'],
  ['eval_results', 'idx_eval_results_tenant_engine', '100000 100000 100000 100000'],
  ['eval_results', 'idx_eval_results_tenant_run', '100000 100000 100000'],
  ['eval_results', 'idx_eval_results_tenant_trace', '100000 100000 1'],
  ['eval_results', 'idx_eval_results_tenant_type', '100000 100000 100000'],
  ['eval_results', 'idx_eval_results_trace_id', '100000 1'],
  ['eval_results', 'sqlite_autoindex_eval_results_1', '100000 1'],
  ['spans', 'idx_spans_tenant_error', '0 0 0 0'],
  ['traces', 'idx_traces_agent_name', '100000 14286'],
  ['traces', 'idx_traces_search_filter', '100000 1 1 1 1 1 1 1 1'],
  ['traces', 'idx_traces_tenant_agent_timestamp', '100000 100000 14286 1 1 1'],
  ['traces', 'idx_traces_tenant_case', '100000 100000 1'],
  ['traces', 'idx_traces_tenant_framework', '100000 100000 50000'],
  ['traces', 'idx_traces_tenant_run', '100000 100000 100000'],
  ['traces', 'idx_traces_tenant_session', '100000 100000 100000 1'],
  ['traces', 'idx_traces_tenant_timestamp_cover', '100000 100000 1 1 1 1 1 1'],
  ['traces', 'idx_traces_tenant_tools_hash', '100000 100000 100000'],
  ['traces', 'idx_traces_timestamp', '100000 1'],
  ['traces', 'sqlite_autoindex_traces_1', '100000 1'],
];
/** The same store with one trace in a hundred evaluated. */
const SPARSE_100K: StatRow[] = DENSE_100K.map(([t, i, s]) => [t, i, t === 'eval_results' ? s.replaceAll('100000', '1000') : s]);

type Stats = 'none' | 'analyze' | 'dense-100k' | 'sparse-100k';

function applyStats(db: Driver, stats: Stats): void {
  if (stats === 'none') return;
  db.exec('ANALYZE');
  if (stats === 'analyze') return;
  db.exec('DELETE FROM sqlite_stat1');
  const put = db.prepare('INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (?, ?, ?)');
  for (const [t, i, s] of stats === 'dense-100k' ? DENSE_100K : SPARSE_100K) put.run(t, i, s);
  // Makes the connection read the statistics just written.
  db.exec('ANALYZE sqlite_schema');
}

/* ---- Capturing what a read issues ---- */

interface Issued {
  sql: string;
  params: unknown[];
}

function capture(db: Driver): { issued: Issued[]; restore: () => void } {
  const issued: Issued[] = [];
  const prepare = db.prepare;
  db.prepare = (sql: string): Statement => {
    const st = prepare.call(db, sql);
    const record =
      (method: keyof Statement) =>
      (...params: unknown[]) => {
        issued.push({ sql, params });
        return st[method](...params);
      };
    return { run: record('run'), get: record('get'), all: record('all') } as Statement;
  };
  return { issued, restore: () => (db.prepare = prepare) };
}

interface PlanRow {
  id: number;
  parent: number;
  detail: string;
}
const explain = (db: Driver, { sql, params }: Issued): PlanRow[] => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as PlanRow[];
/** The rows of the statement itself, not of a subquery inside it. */
const topLevel = (rows: PlanRow[]): string[] => rows.filter((r) => r.parent === 0).map((r) => r.detail);

/* ---- What each read must look like ---- */

/** A full read of a big table, by its name or the alias the queries give it. */
const FULL_SCAN = /\bSCAN (traces|eval_results|spans|t|e|e2|s)\b/;
const TRACE_BY_ID = /^SEARCH t USING (COVERING )?INDEX (sqlite_autoindex_traces_1|idx_traces_search_filter) \(trace_id=\?/;

/** A join: the SQL it is recognised by, and its plan's lines in order, outer table first. */
const JOINS: Array<{ name: string; sql: RegExp; order: RegExp[] }> = [
  {
    name: 'failure log, walked by trace',
    sql: /FROM traces t INDEXED BY idx_traces_tenant_agent_timestamp\s+CROSS JOIN eval_results e/,
    order: [/^SEARCH t USING COVERING INDEX idx_traces_tenant_agent_timestamp \(tenant_id=\? AND agent_name=\?/, /^SEARCH e USING INDEX idx_eval_results_tenant_trace \(tenant_id=\? AND trace_id=\?\)/],
  },
  {
    name: 'failure log, read by evaluation',
    sql: /FROM eval_results e INDEXED BY idx_eval_results_tenant_trace\s+CROSS JOIN traces t/,
    order: [/^SEARCH e USING (COVERING )?INDEX idx_eval_results_tenant_trace \(tenant_id=\?\)/, TRACE_BY_ID],
  },
  {
    name: 'case results by case key or session',
    sql: /FROM traces t INDEXED BY idx_traces_tenant_(case|session) CROSS JOIN eval_results e/,
    order: [/^SEARCH t USING INDEX idx_traces_tenant_(case \(tenant_id=\? AND case_key=\?\)|session \(tenant_id=\? AND session_id=\?)/, /^SEARCH e USING INDEX idx_eval_results_tenant_trace \(tenant_id=\? AND trace_id=\?\)/],
  },
  {
    name: 'case results over every evaluation',
    sql: /FROM eval_results e INDEXED BY idx_eval_results_tenant_created CROSS JOIN traces t/,
    order: [/^SEARCH e USING INDEX idx_eval_results_tenant_created \(tenant_id=\?\)/, TRACE_BY_ID],
  },
  {
    name: 'search, the matches joined to their traces',
    sql: /\) m CROSS JOIN traces ON traces\.trace_id = m\.matched_id/,
    order: [/VIRTUAL TABLE INDEX/, /^SEARCH traces USING (COVERING )?INDEX (sqlite_autoindex_traces_1|idx_traces_search_filter) \(trace_id=\?/],
  },
];

/** Beyond the named indexes: reads whose shape matters on its own. */
const SHAPES: Array<{ name: string; sql: RegExp; fts?: true; plan: (lines: string[], rows: PlanRow[]) => void }> = [
  {
    name: 'the latest evaluation of a trace, for min_score / max_score',
    sql: /SELECT e2\.rowid FROM eval_results e2/,
    plan: (lines) => expect(lines).toContainEqual(expect.stringMatching(/^SEARCH e2 USING INDEX idx_eval_results_tenant_trace \(tenant_id=\? AND trace_id=\?\)/)),
  },
  {
    name: 'a page in time order streams from its index, never sorts the traces',
    sql: /^SELECT \* FROM traces INDEXED BY \w+ .* ORDER BY timestamp desc LIMIT/s,
    plan: (_lines, rows) => expect(topLevel(rows).join(' | ')).not.toMatch(/TEMP B-TREE FOR ORDER BY/),
  },
  {
    name: 'an export walks its index a batch at a time, sorting at most the ties of one timestamp',
    sql: /ORDER BY (timestamp|created_at) (DESC|ASC), rowid (DESC|ASC) LIMIT/,
    plan: (_lines, rows) => expect(topLevel(rows).join(' | ')).not.toMatch(/TEMP B-TREE FOR ORDER BY/),
  },
  {
    name: 'an export reads its batch of rows by primary key',
    sql: /INDEXED BY sqlite_autoindex_(traces|eval_results)_1 WHERE tenant_id = \? AND (trace_id|id) IN/,
    plan: (lines) => expect(lines).toContainEqual(expect.stringMatching(/^SEARCH (traces|eval_results) USING INDEX sqlite_autoindex_(traces|eval_results)_1 \((trace_id|id)=\?\)/)),
  },
  {
    name: 'a search finds its page of ids by doc id, one lookup each',
    fts: true,
    sql: /FROM json_each\(\?\) j CROSS JOIN trace_search_docs d ON d\.doc_id = j\.value/,
    plan: (lines) => expect(lines).toEqual([expect.stringMatching(/^SCAN j VIRTUAL TABLE INDEX/), expect.stringMatching(/^SEARCH d USING INTEGER PRIMARY KEY \(rowid=\?\)/)]),
  },
  {
    name: 'the filter values are one index seek each',
    sql: /WITH RECURSIVE v\(value\)/,
    plan: (lines) => {
      expect(lines.join(' | ')).not.toMatch(/TEMP B-TREE FOR DISTINCT/);
      for (const line of lines.filter((l) => /^SEARCH traces /.test(l))) expect(line).toMatch(/USING COVERING INDEX idx_traces_tenant_(agent_timestamp|framework)/);
    },
  },
];

/* ---- The hot reads ---- */

/** Read an export to its end. */
async function drain(batches: AsyncGenerator<unknown[]>): Promise<number> {
  let n = 0;
  for await (const batch of batches) n += batch.length;
  return n;
}

const T = LOCAL_TENANT;
/** `indexOnly`: every read of traces or spans in the call answers from index entries, never a row. */
const HOT: Array<{ name: string; fts?: true; indexOnly?: true; read: (s: SqliteAdapter) => Promise<unknown> }> = [
  // The failure log: log_trace and evaluate_output with a cost, OTLP and HTTP evaluate, /moments, /failures, views, webhooks.
  { name: 'failure log, a dense agent, windowed walk', read: (s) => s.getAgentFailureLog(T, 'a0', 5) },
  { name: 'failure log, an agent with fewer traces than the tenant has evaluations', read: (s) => s.getAgentFailureLog(T, 'a1') },
  { name: 'failure log, an agent with more traces than the tenant has evaluations', read: (s) => s.getAgentFailureLog(T, 'a2') },
  { name: 'failure log, an agent with no traces', read: (s) => s.getAgentFailureLog(T, 'nobody') },
  // Webhook moment events and the case views.
  { name: 'case results by case key', read: (s) => s.getCaseResults(T, { caseKey: 'case-0' }) },
  { name: 'case results by session', read: (s) => s.getCaseResults(T, { session: 's-0', groupBy: 'session' }) },
  { name: 'case results for every case', read: (s) => s.getCaseResults(T) },
  { name: 'case results for a run', read: (s) => s.getCaseResults(T, { run: 'r-1' }) },
  // get_traces and the dashboard trace list, the moments window, the failures scan.
  { name: 'get_traces, first page', read: (s) => s.queryTraces(T, { limit: 50 }) },
  { name: 'get_traces, one agent', read: (s) => s.queryTraces(T, { limit: 50, filter: { agent_name: 'a1' } }) },
  { name: 'get_traces, one agent since a time', read: (s) => s.queryTraces(T, { limit: 50, filter: { agent_name: 'a1', since: at(200) } }) },
  { name: 'get_traces, one session', read: (s) => s.queryTraces(T, { limit: 50, filter: { session_id: 's-5' } }) },
  { name: 'get_traces, one framework', read: (s) => s.queryTraces(T, { limit: 50, filter: { framework: 'autogen' } }) },
  { name: 'get_traces, a time window', read: (s) => s.queryTraces(T, { limit: 50, filter: { since: at(100), until: at(300) } }) },
  { name: 'get_traces, by cost', read: (s) => s.queryTraces(T, { limit: 50, sort_by: 'cost_usd', sort_order: 'desc' }) },
  { name: 'get_traces, one framework by latency', read: (s) => s.queryTraces(T, { limit: 50, sort_by: 'latency_ms', filter: { framework: 'langchain' } }) },
  { name: 'get_traces, min_score and max_score', read: (s) => s.queryTraces(T, { limit: 50, filter: { min_score: 0.2, max_score: 0.8 } }) },
  { name: 'moments window, 200 newest', read: (s) => s.queryTraces(T, { limit: 200, sort_by: 'timestamp', sort_order: 'desc', filter: {} }) },
  { name: 'page evaluations', read: async (s) => s.getEvalsByTraceIds(T, (await s.queryTraces(T, { limit: 200 })).traces.map((t) => t.trace_id)) },
  // The exports (#4): the dashboard's CSV and JSON Lines downloads, in batches small enough here that every keyset step runs.
  { name: 'export traces, newest first', read: (s) => drain(s.exportTraces(T, {}, 64)) },
  { name: 'export traces, oldest first', read: (s) => drain(s.exportTraces(T, { sort_order: 'asc' }, 64)) },
  { name: 'export traces, one agent', read: (s) => drain(s.exportTraces(T, { filter: { agent_name: 'a1' } }, 16)) },
  { name: 'export traces, one agent since a time', read: (s) => drain(s.exportTraces(T, { filter: { agent_name: 'a2', since: at(250) }, sort_order: 'asc' }, 16)) },
  { name: 'export traces, one session', read: (s) => drain(s.exportTraces(T, { filter: { session_id: 's-5' } }, 2)) },
  { name: 'export traces, one framework in a window', read: (s) => drain(s.exportTraces(T, { filter: { framework: 'autogen', since: at(100), until: at(300) } }, 16)) },
  { name: 'export traces, by cost', read: (s) => drain(s.exportTraces(T, { sort_by: 'cost_usd', sort_order: 'desc' }, 64)) },
  { name: 'export traces, a search', fts: true, read: (s) => drain(s.exportTraces(T, { search: 'refund' }, 64)) },
  { name: 'export evaluations', read: (s) => drain(s.exportEvalResults(T, {}, 64)) },
  { name: 'export evaluations, failed in a window', read: (s) => drain(s.exportEvalResults(T, { passed: false, since: new Date(BASE).toISOString() }, 16)) },
  // The start's fill of stored risk estimates (migration 018): each of its reads, as a start with nothing left to fill runs them.
  {
    name: 'the risk estimate fill at a start',
    read: async (s) => {
      const db = (s as unknown as { db: Driver }).db;
      const [unversioned, below, above] = RISK_FILL_QUERIES.map((sql) => db.prepare(sql));
      return [unversioned.all(8), below.all(RISK_KEY_VERSION, 8), above.all(RISK_KEY_VERSION, 8)];
    },
  },
  // Search: get_traces with q, the dashboard search box.
  { name: 'search, ranked', fts: true, read: (s) => s.queryTraces(T, { limit: 50, search: 'refund' }) },
  { name: 'search, by time', fts: true, read: (s) => s.queryTraces(T, { limit: 50, search: 'refund', sort_by: 'timestamp' }) },
  { name: 'search, one agent', fts: true, read: (s) => s.queryTraces(T, { limit: 50, search: 'refund approved', filter: { agent_name: 'a2' } }) },
  { name: 'search, one framework since a time', fts: true, read: (s) => s.queryTraces(T, { limit: 50, search: 'refund', filter: { framework: 'autogen', since: at(100) } }) },
  { name: 'search, one session by cost', fts: true, read: (s) => s.queryTraces(T, { limit: 50, search: 'order', sort_by: 'cost_usd', filter: { session_id: 's-5' } }) },
  // The dashboard's first render.
  { name: '/filters', indexOnly: true, read: (s) => Promise.all([s.getDistinctValues(T, 'agent_name'), s.getDistinctValues(T, 'framework')]) },
  { name: '/summary, 24 hours', indexOnly: true, read: (s) => s.getDashboardSummary(T, 24) },
  { name: '/summary, 30 days', indexOnly: true, read: (s) => s.getDashboardSummary(T, 720) },
  { name: '/eval-stats, 30 days', indexOnly: true, read: (s) => s.getEvalStats(T, '30d') },
];

/* ---- The variants ---- */

const DRIVERS: Array<'native' | 'node'> = ['native', ...(nodeSqliteAvailable() ? (['node'] as const) : [])];
const VARIANTS = DRIVERS.flatMap((driver) =>
  [...(driverHasFts5(driver) ? [true] : []), false].flatMap((fts5) =>
    (['none', 'analyze', 'dense-100k', 'sparse-100k'] as const).map((stats) => ({ driver, fts5, stats })),
  ),
);

async function open(driver: 'native' | 'node', fts5: boolean, stats: Stats): Promise<{ store: SqliteAdapter; db: Driver }> {
  const dir = mkdtempSync(join(tmpdir(), 'iris-plans-'));
  dirs.push(dir);
  // Searches on this connection, not the worker, so the capture sees them; the worker runs the same SQL (search-match.ts).
  const store = new SqliteAdapter(join(dir, 'iris.db'), { driver, searchWorker: false, ...(fts5 ? {} : { fts5: false }) });
  await store.initialize();
  await store.whenSearchIndexReady();
  await seed(store);
  // Nothing of the start's own runs while a read is captured.
  await store.whenRiskEstimatesStored();
  const db = (store as unknown as { db: Driver }).db;
  applyStats(db, stats);
  return { store, db };
}

describe('every hot read keeps its plan', () => {
  it('runs on both drivers where this Node has the built-in, with and without the search index', () => {
    expect(DRIVERS[0]).toBe('native');
    expect(VARIANTS.length).toBeGreaterThanOrEqual(8);
  });

  for (const { driver, fts5, stats } of VARIANTS) {
    it(`${driver}, ${fts5 ? 'with' : 'without'} the search index, statistics: ${stats}`, async () => {
      const { store, db } = await open(driver, fts5, stats);
      try {
        const statsRows = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'").get() as { n: number }).n;
        expect(statsRows).toBe(stats === 'none' ? 0 : 1);
        const joinsSeen = new Set<string>();
        const shapesSeen = new Set<string>();
        for (const hot of HOT) {
          if (hot.fts && !fts5) continue;
          const { issued, restore } = capture(db);
          try {
            await hot.read(store);
          } finally {
            restore();
          }
          expect(issued.length, hot.name).toBeGreaterThan(0);
          for (const statement of issued) {
            const rows = explain(db, statement);
            const lines = rows.map((r) => r.detail);
            const where = `${hot.name}\n${statement.sql.replace(/\s+/g, ' ')}\n${lines.join('\n')}`;
            for (const line of lines) expect(line, where).not.toMatch(FULL_SCAN);
            expect(lines.join('\n'), where).not.toMatch(/AUTOMATIC/);
            for (const [, index] of statement.sql.matchAll(/INDEXED BY (\w+)/g)) expect(lines.join('\n'), where).toContain(index);
            for (const j of JOINS.filter((x) => x.sql.test(statement.sql))) {
              joinsSeen.add(j.name);
              const at = j.order.map((re) => lines.findIndex((l) => re.test(l)));
              expect(at.every((i) => i >= 0), where).toBe(true);
              expect([...at].sort((a, b) => a - b), where).toEqual(at);
            }
            for (const s of SHAPES.filter((x) => x.sql.test(statement.sql))) {
              shapesSeen.add(s.name);
              s.plan(lines, rows);
            }
            if (hot.indexOnly) for (const line of lines.filter((l) => /^SEARCH (traces|t|spans|s) /.test(l))) expect(line, where).toMatch(/ USING COVERING INDEX /);
          }
        }
        // Every join was exercised, including both ways of reading the failure log.
        expect([...joinsSeen].sort()).toEqual(JOINS.map((j) => j.name).filter((n) => fts5 || !n.startsWith('search')).sort());
        // And every shape was checked on some statement.
        expect([...shapesSeen].sort()).toEqual(SHAPES.filter((s) => fts5 || !s.fts).map((s) => s.name).sort());
      } finally {
        await store.close();
      }
    });
  }
});
