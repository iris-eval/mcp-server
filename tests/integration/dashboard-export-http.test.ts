/*
 * GET /api/v1/traces/export and /api/v1/evaluations/export (#4) against
 * the REAL dashboard server over a real socket, behind the same guard,
 * auth, tenant and rate-limit middleware as every other read.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { asTenantId, LOCAL_TENANT } from '../../src/types/tenant.js';
import { CSV_BOM, EVAL_COLUMNS, TRACE_COLUMNS } from '../../src/export/format.js';
import type { TraceRecord } from '../../src/types/query.js';
import { parseCsv } from '../helpers/csv.js';
import { SEARCH_DRIVER } from '../unit/storage/fts5-here.js';
import { EvalEngine } from '../../src/eval/engine.js';

const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const booted: Array<{ server: Server; storage: SqliteAdapter }> = [];

afterEach(async () => {
  for (const b of booted.splice(0)) {
    b.server.closeAllConnections?.();
    await new Promise<void>((resolve) => b.server.close(() => resolve()));
    await b.storage.close();
  }
});

async function boot(apiKey?: string): Promise<{ base: string; storage: SqliteAdapter }> {
  const storage = new SqliteAdapter(':memory:', { driver: SEARCH_DRIVER });
  await storage.initialize();
  await storage.whenSearchIndexReady();
  const config = { ...defaultConfig, dashboard: { ...defaultConfig.dashboard, port: 0 }, security: { ...defaultConfig.security, apiKey } };
  const evalEngine = new EvalEngine(config.eval.defaultThreshold, config.eval.ruleThresholds);
  const server = createDashboardServer(storage, config, quiet, { evalEngine }).start();
  await new Promise((r) => server.once('listening', r));
  booted.push({ server, storage });
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, storage };
}

async function post(base: string, body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${base}/api/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { trace_id: string }).trace_id;
}

const exportUrl = (base: string, kind: string, query: Record<string, string>) => `${base}/api/v1/${kind}/export?${new URLSearchParams(query)}`;
/** The body as sent: fetch's text() drops a leading BOM, which is part of what is tested here. */
const body = async (res: Response) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
const jsonl = (text: string) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as TraceRecord);

describe('GET /api/v1/traces/export', () => {
  it('streams CSV with a BOM, the documented columns, the attachment headers, and the list’s filters and search applied', async () => {
    const { base } = await boot();
    const refund = await post(base, {
      agent_name: 'support-bot',
      input: 'Can I get my money back for order 5521?',
      output: '=HYPERLINK("http://evil.example","Refund approved") for order 5521, "quoted", and\na second line — 返金',
      evaluate: true,
    });
    await post(base, { agent_name: 'support-bot', output: 'Refunds take five days.' });
    await post(base, { agent_name: 'sales-bot', output: 'Order 5521 refund upgraded to express.' });

    const res = await fetch(exportUrl(base, 'traces', { format: 'csv', q: 'order 5521 refund', agent_name: 'support-bot' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8; header=present');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="iris-traces-\d{4}-\d{2}-\d{2}T\d{6}Z\.csv"$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)], 'UTF-8 BOM').toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    const [header, ...rows] = parseCsv(text.slice(CSV_BOM.length));
    expect(header).toEqual(TRACE_COLUMNS.map((c) => c.name));
    expect(rows).toHaveLength(1);
    const cell = (name: string) => rows[0][header.indexOf(name)];
    expect(cell('trace_id')).toBe(refund);
    expect(cell('output')).toBe(`'=HYPERLINK("http://evil.example","Refund approved") for order 5521, "quoted", and\na second line — 返金`);
    expect(cell('eval_count')).toBe('1');
    expect(cell('latest_verdict')).toMatch(/^(pass|fail|unknown)$/);
  });

  it('streams JSON Lines, one trace per line, each exactly what GET /traces/:id answers', async () => {
    const { base } = await boot();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await post(base, { agent_name: 'bot', output: `answer ${i}`, spans: [{ name: 'llm', kind: 'LLM', status_code: 'OK', start_time: new Date().toISOString() }], evaluate: i === 1 }));
    }
    const res = await fetch(exportUrl(base, 'traces', { format: 'jsonl', sort_by: 'timestamp', sort_order: 'asc' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/filename="iris-traces-.*\.jsonl"/);
    const records = jsonl(await res.text());
    expect(records.map((r) => r.trace.trace_id).sort()).toEqual([...ids].sort());
    for (const record of records) {
      const detail = await (await fetch(`${base}/api/v1/traces/${record.trace.trace_id}`)).json();
      expect(record).toEqual(detail);
    }
    expect(records.find((r) => r.trace.trace_id === ids[1])!.evals).toHaveLength(1);
  });

  it('says whether each cost was reported or estimated from the tokens: a cost_source column, and cost_source with cost_estimate in JSON Lines', async () => {
    const { base } = await boot();
    const tokens = { prompt_tokens: 150_000, completion_tokens: 10_000, total_tokens: 160_000 };
    const reported = await post(base, { agent_name: 'bot', output: 'a', cost_usd: 0.5, timestamp: '2026-09-28T10:00:00.000Z' });
    const estimated = await post(base, { agent_name: 'bot', output: 'b', token_usage: tokens, metadata: { model: 'gpt-4o-mini' }, timestamp: '2026-09-28T10:01:00.000Z' });
    const none = await post(base, { agent_name: 'bot', output: 'c', timestamp: '2026-09-28T10:02:00.000Z' });

    const [header, ...rows] = parseCsv((await body(await fetch(exportUrl(base, 'traces', { format: 'csv' })))).slice(CSV_BOM.length));
    const byId = new Map(rows.map((r) => [r[header.indexOf('trace_id')], r]));
    const cell = (id: string, name: string) => byId.get(id)![header.indexOf(name)];
    expect(header.indexOf('cost_source'), 'right after cost_usd').toBe(header.indexOf('cost_usd') + 1);
    expect([cell(reported, 'cost_usd'), cell(reported, 'cost_source')]).toEqual(['0.5', 'reported']);
    expect(Number(cell(estimated, 'cost_usd'))).toBeGreaterThan(0);
    expect(cell(estimated, 'cost_source')).toBe('estimated');
    expect([cell(none, 'cost_usd'), cell(none, 'cost_source')]).toEqual(['', '']);

    const records = new Map(jsonl(await (await fetch(exportUrl(base, 'traces', { format: 'jsonl' }))).text()).map((r) => [r.trace.trace_id, r.trace]));
    expect(records.get(reported)).toMatchObject({ cost_usd: 0.5, cost_source: 'reported' });
    expect(records.get(estimated)).toMatchObject({ cost_source: 'estimated', cost_estimate: { status: 'estimated', basis: 'token_usage', calls: [{ priced_as: 'gpt-4o-mini' }] } });
    expect(records.get(none)!.cost_source).toBeUndefined();
  });

  it('never exports another tenant’s rows', async () => {
    const { base, storage } = await boot();
    const mine = await post(base, { agent_name: 'bot', output: 'shared words here' });
    await storage.insertTrace(asTenantId('someone-else'), { trace_id: 'theirs', agent_name: 'bot', output: 'shared words here', timestamp: new Date().toISOString() });
    await storage.insertEvalResult(asTenantId('someone-else'), { id: 'their-eval', trace_id: 'theirs', eval_type: 'safety', output_text: 'x', score: 1, passed: true, rule_results: [] });
    for (const query of [{ format: 'jsonl' }, { format: 'jsonl', q: 'shared words' }] as Array<Record<string, string>>) {
      expect(jsonl(await (await fetch(exportUrl(base, 'traces', query))).text()).map((r) => r.trace.trace_id)).toEqual([mine]);
    }
    expect(await (await fetch(exportUrl(base, 'evaluations', { format: 'jsonl' }))).text()).toBe('');
  });

  it('refuses what the list refuses: a missing or unknown format, an unknown parameter, relevance without q, crossed bounds', async () => {
    const { base } = await boot();
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{}, /format/],
      [{ format: 'xlsx' }, /format must be one of: csv, jsonl/],
      [{ format: 'csv', limit: '10' }, /Unknown query parameter\(s\).*limit/],
      [{ format: 'csv', sort_by: 'relevance' }, /ranks a search/],
      [{ format: 'csv', min_score: '0.9', max_score: '0.1' }, /min_score/],
    ];
    for (const [query, message] of cases) {
      const res = await fetch(exportUrl(base, 'traces', query));
      expect(res.status, JSON.stringify(query)).toBe(400);
      expect(JSON.stringify(await res.json())).toMatch(message);
    }
  });

  it('sits behind the same guard and key as every read: a foreign Origin is refused, and with a key set, no key is refused', async () => {
    const open = await boot();
    const foreign = await fetch(exportUrl(open.base, 'traces', { format: 'csv' }), { headers: { origin: 'http://evil.example' } });
    expect(foreign.status).toBe(403);

    const locked = await boot('export-test-key-1234567890');
    expect((await fetch(exportUrl(locked.base, 'traces', { format: 'csv' }))).status).toBe(401);
    const ok = await fetch(exportUrl(locked.base, 'traces', { format: 'csv' }), { headers: { authorization: 'Bearer export-test-key-1234567890' } });
    expect(ok.status).toBe(200);
    expect(await body(ok)).toBe(CSV_BOM + `${TRACE_COLUMNS.map((c) => c.name).join(',')}\r\n`);
  });

  it('ends a failed export by breaking the connection, never with a file that looks complete', async () => {
    const { base, storage } = await boot();
    for (let i = 0; i < 3; i++) await post(base, { agent_name: 'bot', output: `row ${i}` });
    const real = storage.exportTraces.bind(storage);
    storage.exportTraces = async function* (tenant, options) {
      let n = 0;
      for await (const batch of real(tenant, options, 1)) {
        if (n++ === 1) throw new Error('disk went away');
        yield batch;
      }
    };
    const res = await fetch(exportUrl(base, 'traces', { format: 'jsonl' }));
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow();
    // And the server is still answering.
    expect((await fetch(`${base}/api/v1/traces`)).status).toBe(200);
  });

  it('a query that fails before the first row is an ordinary JSON error', async () => {
    const { base, storage } = await boot();
    storage.exportTraces = async function* () {
      throw Object.assign(new Error('Invalid sort column: nope'), { status: 400 });
    };
    const res = await fetch(exportUrl(base, 'traces', { format: 'csv' }));
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });

  it('stops reading when the client goes away part-way, and keeps serving', async () => {
    const { base, storage } = await boot();
    const big = 'x'.repeat(20_000);
    await storage.insertTraces(LOCAL_TENANT, Array.from({ length: 2000 }, (_, i) => ({ trace_id: `t${i}`, agent_name: 'bot', output: big, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() })));
    let batchesRead = 0;
    const real = storage.exportTraces.bind(storage);
    let finished = false;
    storage.exportTraces = async function* (tenant, options) {
      try {
        for await (const batch of real(tenant, options, 50)) {
          batchesRead++;
          yield batch;
        }
      } finally {
        finished = true;
      }
    };
    const controller = new AbortController();
    const res = await fetch(exportUrl(base, 'traces', { format: 'jsonl' }), { signal: controller.signal });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await new Promise((r) => setTimeout(r, 300));
    expect(finished, 'the storage read was closed').toBe(true);
    expect(batchesRead, 'far fewer than the 40 batches of the whole export were read').toBeLessThan(40);
    expect((await fetch(`${base}/api/v1/traces?limit=1`)).status).toBe(200);
  });
});

describe('GET /api/v1/evaluations/export', () => {
  it('streams the evaluation list with its filters, as CSV and as JSON Lines', async () => {
    const { base, storage } = await boot();
    const at = (m: number) => new Date(Date.UTC(2026, 8, 1, 0, m)).toISOString();
    await storage.insertEvalResult(LOCAL_TENANT, { id: 'e1', eval_type: 'safety', output_text: '@SUM(1)', score: 0.2, passed: false, rule_results: [{ ruleName: 'no_pii', passed: false, score: 0, message: '' }], created_at: at(1) });
    await storage.insertEvalResult(LOCAL_TENANT, { id: 'e2', eval_type: 'safety', output_text: 'fine', score: 1, passed: true, rule_results: [], created_at: at(2) });
    await storage.insertEvalResult(LOCAL_TENANT, { id: 'e3', eval_type: 'completeness', output_text: 'meh', score: 0.1, passed: false, rule_results: [], created_at: at(3) });

    const csv = await fetch(exportUrl(base, 'evaluations', { format: 'csv', passed: 'false' }));
    expect(csv.headers.get('content-disposition')).toMatch(/filename="iris-evaluations-.*\.csv"/);
    const [header, ...rows] = parseCsv((await body(csv)).slice(CSV_BOM.length));
    expect(header).toEqual(EVAL_COLUMNS.map((c) => c.name));
    expect(rows.map((r) => r[0])).toEqual(['e3', 'e1']);
    expect(rows[1][header.indexOf('output_text')]).toBe(`'@SUM(1)`);
    expect(rows[1][header.indexOf('failed_rules')]).toBe('no_pii');

    const lines = (await (await fetch(exportUrl(base, 'evaluations', { format: 'jsonl', eval_type: 'safety' }))).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const listed = (await (await fetch(`${base}/api/v1/evaluations?eval_type=safety`)).json()) as { results: unknown[] };
    expect(lines).toEqual(listed.results);
  });
});
