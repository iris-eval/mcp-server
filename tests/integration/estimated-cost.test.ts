/*
 * Estimated cost through every ingest door (#702).
 *
 * The same trace — 150,000 input and 10,000 output tokens of gpt-4o-mini,
 * no cost — goes in through each door a trace can take, and each must store
 * $0.0285 marked `estimated`, answer with it, and score it with the cost
 * rules saying it was estimated:
 *
 *   log_trace                 the MCP tool, over the SDK's in-memory transport
 *   POST /api/v1/traces       the HTTP door, on a real socket
 *   POST /v1/traces           the OTLP door, the path the SDK and Python wrappers
 *                             and the LangChain handlers send to
 *   iris-eval ingest          the CLI (hooks, CI), a spawned process with its own
 *                             IRIS_HOME and config.json
 *
 * Worked by hand: 150,000 × $0.15 / 1M + 10,000 × $0.60 / 1M = $0.0225 + $0.006.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../src/server.js';
import { createCustomRuleStore } from '../../src/custom-rule-store.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { EvalEngine } from '../../src/eval/engine.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import { momentsOf } from '../../src/notify/events.js';
import { COST_ANOMALY_MIN_HISTORY } from '../../src/eval/cost-anomaly.js';

const COST = 0.0285;
const TOKENS = { prompt_tokens: 150_000, completion_tokens: 10_000, total_tokens: 160_000 };
const OUTPUT = 'The quarterly report is attached. Revenue grew in every region, and the outlook remains stable for next year.';
const ESTIMATED_NOTE = /\(estimated by Iris: 150,000 input and 10,000 output tokens at gpt-4o-mini list price as of 2026-09-28; the trace reported no cost\)$/;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

type Rule = { ruleName: string; passed: boolean; skipped?: boolean; message: string; evidence?: Array<Record<string, unknown>> };
const ruleOf = (evaluation: unknown, name: string): Rule => {
  const rules = (evaluation as { rule_results: Rule[] }).rule_results;
  const found = rules.find((r) => r.ruleName === name);
  expect(found, `${name} ran`).toBeDefined();
  return found!;
};

/* ---- the MCP door ---- */

async function mcp(): Promise<{ client: Client; storage: SqliteAdapter }> {
  const storage = new SqliteAdapter(':memory:');
  await storage.initialize();
  const ruleDir = mkdtempSync(join(tmpdir(), 'iris-estcost-'));
  const ruleStore = createCustomRuleStore({ pathFor: () => join(ruleDir, 'custom-rules.json'), auditPath: join(ruleDir, 'audit.log') });
  const { mcpServer } = createIrisServer(defaultConfig, storage, ruleStore);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: 'estimated-cost', version: '0.1.0' });
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await storage.close();
    rmSync(ruleDir, { recursive: true, force: true });
  });
  return { client, storage };
}

const parse = (r: { content?: unknown }) => JSON.parse((r.content as Array<{ text: string }>)[0].text) as Record<string, unknown>;

describe('log_trace (MCP)', () => {
  it('stores the estimate, answers with it, and the cost rule scores it and says it was estimated', async () => {
    const { client, storage } = await mcp();
    const res = parse(await client.callTool({ name: 'log_trace', arguments: { agent_name: 'mcp-bot', output: OUTPUT, token_usage: TOKENS, metadata: { model: 'gpt-4o-mini' }, evaluate: true, eval_type: 'cost' } }));
    expect(res).toMatchObject({ status: 'stored', cost_usd: COST, cost_source: 'estimated', cost_estimate: { status: 'estimated', basis: 'token_usage', calls: [{ priced_as: 'gpt-4o-mini', price_as_of: '2026-09-28' }] } });
    const rule = ruleOf(res.evaluation, 'cost_under_threshold');
    expect(rule.skipped).toBeFalsy();
    expect(rule.passed).toBe(true);
    expect(rule.message).toMatch(/^Cost \(\$0\.0285\) is under threshold \(\$0\.1000\)/);
    expect(rule.message).toMatch(ESTIMATED_NOTE);
    expect(rule.evidence?.[0]).toMatchObject({ stat: 'cost', value: COST, costSource: 'estimated' });

    const stored = await storage.getTrace(LOCAL_TENANT, res.trace_id as string);
    expect(stored).toMatchObject({ cost_usd: COST, cost_source: 'estimated' });

    // get_traces carries the source on every trace it returns.
    const page = parse(await client.callTool({ name: 'get_traces', arguments: { agent_name: 'mcp-bot' } }));
    expect((page.traces as Array<Record<string, unknown>>)[0]).toMatchObject({ cost_usd: COST, cost_source: 'estimated' });

    // evaluate_output with the trace_id and no cost_usd reads the stored cost, estimate included.
    const again = parse(await client.callTool({ name: 'evaluate_output', arguments: { output: OUTPUT, trace_id: res.trace_id, eval_type: 'cost' } }));
    expect(ruleOf(again, 'cost_under_threshold').message).toMatch(ESTIMATED_NOTE);
  });

  it('a reported cost wins and is never overwritten, and the rule message carries no estimate note', async () => {
    const { client } = await mcp();
    const res = parse(await client.callTool({ name: 'log_trace', arguments: { agent_name: 'mcp-bot', output: OUTPUT, token_usage: TOKENS, metadata: { model: 'gpt-4o-mini' }, cost_usd: 0.5, evaluate: true, eval_type: 'cost' } }));
    expect(res).toMatchObject({ cost_usd: 0.5, cost_source: 'reported' });
    expect(res.cost_estimate).toBeUndefined();
    const rule = ruleOf(res.evaluation, 'cost_under_threshold');
    expect(rule.message).toBe('Cost ($0.5000) exceeds threshold ($0.1000)');
    expect(rule.evidence?.[0].costSource).toBeUndefined();
  });

  it('an unknown model: cost null, the reason in the answer, and the cost rule skips as before', async () => {
    const { client } = await mcp();
    const res = parse(await client.callTool({ name: 'log_trace', arguments: { agent_name: 'mcp-bot', output: OUTPUT, token_usage: TOKENS, metadata: { model: 'llama-3.1-70b' }, evaluate: true, eval_type: 'cost' } }));
    expect(res.cost_usd).toBeNull();
    expect(res.cost_source).toBeUndefined();
    expect(res.cost_estimate).toMatchObject({ status: 'unpriced', reason: 'unknown_model', models: ['llama-3.1-70b'] });
    expect(ruleOf(res.evaluation, 'cost_under_threshold').skipped).toBe(true);
  });

  it('cost_source cannot be sent: the server sets it', async () => {
    const { client } = await mcp();
    const r = await client.callTool({ name: 'log_trace', arguments: { agent_name: 'mcp-bot', cost_usd: 1, cost_source: 'estimated' } });
    expect(r.isError).toBe(true);
  });
});

/* ---- the HTTP and OTLP doors ---- */

async function dashboard(): Promise<{ base: string; storage: SqliteAdapter }> {
  const storage = new SqliteAdapter(':memory:');
  await storage.initialize();
  const config = { ...defaultConfig, dashboard: { ...defaultConfig.dashboard, port: 0 } };
  const evalEngine = new EvalEngine(config.eval.defaultThreshold, config.eval.ruleThresholds);
  const server: Server = createDashboardServer(storage, config, { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, { evalEngine }).start();
  await new Promise((r) => server.once('listening', r));
  cleanups.push(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    await storage.close();
  });
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, storage };
}

async function post(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
const get = async (url: string) => (await (await fetch(url)).json()) as Record<string, unknown>;

const otlpBody = (extra: Array<{ key: string; value: Record<string, unknown> }> = []) => ({
  resourceSpans: [
    {
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'otel-bot' } }, { key: 'iris.evaluate', value: { boolValue: true } }, { key: 'iris.eval_type', value: { stringValue: 'cost' } }] },
      scopeSpans: [
        {
          scope: { name: 'openai' },
          spans: [
            {
              traceId: '0af7651916cd43dd8448eb211c80319c',
              spanId: 'b7ad6b7169203331',
              name: 'chat gpt-4o-mini',
              startTimeUnixNano: '1759053600000000000',
              endTimeUnixNano: '1759053601000000000',
              attributes: [
                { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
                { key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o-mini' } },
                { key: 'gen_ai.response.model', value: { stringValue: 'gpt-4o-mini-2024-07-18' } },
                { key: 'gen_ai.usage.input_tokens', value: { intValue: 150000 } },
                { key: 'gen_ai.usage.output_tokens', value: { intValue: 10000 } },
                { key: 'gen_ai.output.messages', value: { stringValue: OUTPUT } },
                ...extra,
              ],
            },
          ],
        },
      ],
    },
  ],
});

describe('POST /api/v1/traces', () => {
  it('stores the estimate, answers with it, scores it, and every read and total carries it', async () => {
    const { base } = await dashboard();
    const { status, json } = await post(`${base}/api/v1/traces`, { agent_name: 'http-bot', output: OUTPUT, token_usage: TOKENS, metadata: { model: 'gpt-4o-mini' }, evaluate: true, eval_type: 'cost' });
    expect(status).toBe(201);
    expect(json).toMatchObject({ cost_usd: COST, cost_source: 'estimated', cost_estimate: { status: 'estimated' } });
    expect(ruleOf(json.evaluation, 'cost_under_threshold').message).toMatch(ESTIMATED_NOTE);

    const detail = await get(`${base}/api/v1/traces/${json.trace_id as string}`);
    expect(detail.trace).toMatchObject({ cost_usd: COST, cost_source: 'estimated', cost_estimate: { calls: [{ prompt_tokens: 150_000, completion_tokens: 10_000 }] } });

    await post(`${base}/api/v1/traces`, { agent_name: 'http-bot', output: OUTPUT, cost_usd: 0.01 });
    const summary = await get(`${base}/api/v1/summary`);
    expect(summary).toMatchObject({ total_cost_usd: 0.0385, estimated_cost_usd: 0.0285 });
    const stats = await get(`${base}/api/v1/eval-stats?period=all`);
    expect(stats).toMatchObject({ totalCost: 0.0385, estimatedCost: 0.0285 });
    const view = await get(`${base}/api/v1/views/cost_by_agent?period=all`);
    expect((view.rows as unknown[])[0]).toMatchObject({ agent: 'http-bot', traces: 2, costedTraces: 2, estimatedTraces: 1, totalCostUsd: 0.0385, estimatedCostUsd: 0.0285 });
  });

  it('refuses a cost_source from the caller, and stores nothing', async () => {
    const { base, storage } = await dashboard();
    const { status } = await post(`${base}/api/v1/traces`, { agent_name: 'http-bot', cost_usd: 1, cost_source: 'estimated' });
    expect(status).toBe(400);
    expect((await storage.queryTraces(LOCAL_TENANT, {})).total).toBe(0);
  });
});

describe('POST /v1/traces (OTLP)', () => {
  it('prices the span from its response model, answers per trace with the estimate, and the requested evaluation says so', async () => {
    const { base, storage } = await dashboard();
    const { status, json } = await post(`${base}/v1/traces`, otlpBody());
    expect(status).toBe(200);
    const entry = (json['iris-eval'] as { stored: Array<Record<string, unknown>> }).stored[0];
    expect(entry).toMatchObject({ cost_usd: COST, cost_source: 'estimated', cost_estimate: { calls: [{ model: 'gpt-4o-mini-2024-07-18', priced_as: 'gpt-4o-mini' }] } });
    expect(ruleOf(entry.evaluation, 'cost_under_threshold').message).toMatch(ESTIMATED_NOTE);
    expect(await storage.getTrace(LOCAL_TENANT, entry.trace_id as string)).toMatchObject({ cost_usd: COST, cost_source: 'estimated' });
  });

  it('a cost attribute on the span is reported and wins', async () => {
    const { base } = await dashboard();
    const { json } = await post(`${base}/v1/traces`, otlpBody([{ key: 'gen_ai.usage.cost', value: { doubleValue: 0.02 } }]));
    expect((json['iris-eval'] as { stored: Array<Record<string, unknown>> }).stored[0]).toMatchObject({ cost_usd: 0.02, cost_source: 'reported' });
  });
});

describe('the cost alert acts on estimated costs and says so', () => {
  it(`after ${COST_ANOMALY_MIN_HISTORY} estimated traces, a spike fires cost_anomaly, whose message and webhook detail name the estimate`, async () => {
    const { base, storage } = await dashboard();
    // A steady agent: each run 1,000 input and 100 output tokens of gpt-4o-mini ($0.00021), varied a little so the spread can be read.
    for (let i = 0; i < COST_ANOMALY_MIN_HISTORY; i += 1) {
      const { status } = await post(`${base}/api/v1/traces`, { agent_name: 'steady-bot', output: OUTPUT, token_usage: { prompt_tokens: 1000 + i * 10, completion_tokens: 100 }, metadata: { model: 'gpt-4o-mini' }, evaluate: true, eval_type: 'cost', timestamp: new Date(Date.UTC(2026, 8, 28, 9, i)).toISOString() });
      expect(status).toBe(201);
    }
    const spike = await post(`${base}/api/v1/traces`, { agent_name: 'steady-bot', output: OUTPUT, token_usage: TOKENS, metadata: { model: 'gpt-4o-mini' }, evaluate: true, eval_type: 'cost', timestamp: '2026-09-28T10:00:00.000Z' });
    const anomaly = ruleOf(spike.json.evaluation, 'cost_anomaly');
    expect(anomaly.passed).toBe(false);
    expect(anomaly.message).toMatch(ESTIMATED_NOTE);
    expect(anomaly.evidence?.[0]).toMatchObject({ stat: 'modified_z', costSource: 'estimated' });

    const evaluation = (await storage.getEvalsByTraceId(LOCAL_TENANT, spike.json.trace_id as string))[0];
    const moments = await momentsOf(storage, LOCAL_TENANT, evaluation, new Set(['cost_anomaly'] as const));
    expect(moments).toHaveLength(1);
    expect(moments[0].summary).toMatch(ESTIMATED_NOTE);
    expect(moments[0].detail).toMatchObject({ cost_usd: COST, cost_source: 'estimated' });
  });
});

/* ---- the CLI door, with the deployment's config.json ---- */

const repoRoot = resolve(__dirname, '..', '..');
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'iris-estcost-cli-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function ingest(stdin: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve(repoRoot, 'src', 'index.ts'), 'ingest', '--evaluate'], {
      cwd: repoRoot,
      env: { ...process.env, IRIS_HOME: home, IRIS_DB_PATH: join(home, 'iris.db'), IRIS_NO_AUTO_LAUNCH: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.once('error', fail);
    child.once('close', (code) => done({ code, stdout, stderr }));
    child.stdin!.end(stdin);
  });
}

describe('iris-eval ingest', () => {
  it('prices from the built-in table, and from pricing.models in config.json for a model the table does not know', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ pricing: { models: [{ model: 'prod-gpt4o', inputUsdPer1M: 2.75, outputUsdPer1M: 11 }], asOf: '2026-09-01' } }));
    const lines = [
      { agent_name: 'cli-bot', output: OUTPUT, token_usage: TOKENS, metadata: { model: 'gpt-4o-mini' } },
      // 100,000 × $2.75 / 1M + 10,000 × $11 / 1M = $0.275 + $0.11
      { agent_name: 'cli-bot', output: OUTPUT, token_usage: { prompt_tokens: 100_000, completion_tokens: 10_000 }, metadata: { model: 'prod-gpt4o' } },
    ].map((l) => JSON.stringify(l)).join('\n');
    const { code, stdout, stderr } = await ingest(lines);
    expect(code, stderr).toBe(0);
    const out = stdout.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(out[0]).toMatchObject({ cost_usd: COST, cost_source: 'estimated', cost_estimate: { calls: [{ price_source: 'iris', price_as_of: '2026-09-28' }] } });
    expect(out[1]).toMatchObject({ cost_usd: 0.385, cost_source: 'estimated', cost_estimate: { calls: [{ priced_as: 'prod-gpt4o', price_source: 'config', price_as_of: '2026-09-01' }] } });

    const store = new SqliteAdapter(join(home, 'iris.db'));
    await store.initialize();
    const page = await store.queryTraces(LOCAL_TENANT, { sort_by: 'cost_usd', sort_order: 'desc' });
    expect(page.traces.map((t) => [t.cost_usd, t.cost_source])).toEqual([[0.385, 'estimated'], [COST, 'estimated']]);
    await store.close();
  }, 60_000);

  it('pricing.estimate false turns estimates off, and the answer says so', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ pricing: { estimate: false } }));
    const { code, stdout, stderr } = await ingest(JSON.stringify({ agent_name: 'cli-bot', output: OUTPUT, token_usage: TOKENS, metadata: { model: 'gpt-4o-mini' } }));
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout.trim())).toMatchObject({ cost_usd: null, cost_estimate: { status: 'unpriced', reason: 'disabled' } });
  }, 60_000);

  it('a pricing.models entry priced twice is refused at startup, naming it', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ pricing: { models: [{ model: 'x', inputUsdPer1M: 1, outputUsdPer1M: 1 }, { model: 'X', inputUsdPer1M: 2, outputUsdPer1M: 2 }] } }));
    const { code, stderr } = await ingest(JSON.stringify({ agent_name: 'cli-bot' }));
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/"X" is priced twice/);
  }, 60_000);
});
