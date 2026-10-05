/*
 * The relevance judge's spend limits and egress, end to end.
 *
 * The user owns the key and the bill, so this proves, through the servers a
 * user runs and with only the provider's HTTP endpoint replaced:
 *
 *   - the daily budget stops calls once a call's worst case no longer fits,
 *     the evaluation falls back to the lexical reading and says why, one
 *     warning line is logged, and health reports it;
 *   - the budget is kept in the database, so a new server on the same file
 *     starts from what was spent, not from zero;
 *   - one request (evaluate_runs, an OTLP batch) makes at most
 *     IRIS_RELEVANCE_JUDGE_MAX_CALLS_PER_REQUEST judge calls;
 *   - the request body that reaches the provider carries markers, not the
 *     personal data and credentials no_pii flags — and carries them as they
 *     are only when the deployment turns redaction off;
 *   - the tools that may call the provider say so in their annotations.
 *
 * The provider is faked at `fetch`, below the judge client, so what is
 * asserted is the exact body Iris would put on the wire.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../src/server.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { EvalEngine } from '../../src/eval/engine.js';
import { buildHealth } from '../../src/health.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import { relevanceJudgeFromEnv } from '../../src/eval/llm-judge/relevance-judge.js';
import { worstCaseJudgeCostUsd } from '../../src/eval/llm-judge/evaluator.js';
import { estimateCostUsd } from '../../src/eval/llm-judge/pricing.js';
import { nextUtcMidnight, toMicroUsd } from '../../src/eval/llm-judge/budget.js';
import type { IrisConfig } from '../../src/types/config.js';
import { runSelfTest, SELF_TEST_STEPS, SELF_TEST_FAIL_VERDICT } from '../../src/self-test.js';
import { runIngest } from '../../src/cli/ingest.js';
import { Readable, Writable } from 'node:stream';
import { resourceTextOf } from '../helpers/mcp-results.js';

const MODEL = 'claude-haiku-4-5';
const KEY = 'sk-ant-dummy-key-for-tests-0123456789';
const ENV = [
  'IRIS_RELEVANCE_JUDGE_MODEL',
  'IRIS_ANTHROPIC_API_KEY',
  'IRIS_OPENAI_API_KEY',
  'IRIS_LLM_JUDGE_DAILY_BUDGET_USD',
  'IRIS_RELEVANCE_JUDGE_DAILY_BUDGET_USD',
  'IRIS_RELEVANCE_JUDGE_MAX_CALLS_PER_REQUEST',
  'IRIS_RELEVANCE_JUDGE_REDACT',
] as const;
type EnvName = (typeof ENV)[number];

/* ------------------------------------------------------------ the provider */

interface ProviderCall {
  url: string;
  body: { model: string; system: string; messages: Array<{ role: string; content: string }> };
}
const providerCalls: ProviderCall[] = [];
const realFetch = globalThis.fetch;
/** What one judge call costs at the fake provider's reported usage: 900 tokens in, 60 out. */
const ACTUAL = estimateCostUsd(MODEL, 900, 60)!;

beforeAll(() => {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://api.anthropic.com/') && !url.startsWith('https://api.openai.com/')) return realFetch(input, init);
    providerCalls.push({ url, body: JSON.parse(String(init?.body)) as ProviderCall['body'] });
    return new Response(
      JSON.stringify({ id: `msg_${providerCalls.length}`, content: [{ type: 'text', text: '{"score":0.9,"rationale":"on the ask","dimensions":{"addresses_request":0.9}}' }], stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 60 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------- the harness */

const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
let dir: string;
const open: Array<{ close: () => Promise<void> }> = [];

beforeEach(() => {
  providerCalls.length = 0;
  for (const k of ENV) delete process.env[k];
  process.env.IRIS_RELEVANCE_JUDGE_MODEL = MODEL;
  process.env.IRIS_ANTHROPIC_API_KEY = KEY;
  dir = mkdtempSync(join(tmpdir(), 'iris-judge-limits-'));
});
afterEach(async () => {
  for (const o of open.splice(0).reverse()) await o.close();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function env(values: Partial<Record<EnvName, string>>): void {
  Object.assign(process.env, values);
}

async function store(file = join(dir, 'iris.db')): Promise<SqliteAdapter> {
  const storage = new SqliteAdapter(file);
  await storage.initialize();
  open.push({ close: () => storage.close() });
  return storage;
}

async function mcp(storage: SqliteAdapter, warn?: (line: string) => void) {
  const server = createIrisServer(defaultConfig, storage, undefined, warn ? { warn } : {});
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.mcpServer.connect(s);
  const client = new Client({ name: 'judge-limits', version: '0.1.0' });
  await client.connect(c);
  open.push({ close: () => client.close() });
  return { server, client };
}

type Judge = { withheld?: string; error?: string; redacted?: Record<string, number>; sentUnredacted?: boolean; score?: number; costUsd: number | null };
type RuleResult = { ruleName: string; kind?: string; role?: string; judge?: Judge };
type Evaluation = { rule_results: RuleResult[] };

const text = (r: unknown) => ((r as { content: Array<{ type: string; text?: string }> }).content.find((c) => c.type === 'text')!.text!);

async function evaluate(client: Client, args: Record<string, unknown>): Promise<RuleResult> {
  const r = await client.callTool({ name: 'evaluate_output', arguments: { eval_type: 'relevance', ...args } });
  expect((r as { isError?: boolean }).isError, text(r)).toBeFalsy();
  return (JSON.parse(text(r)) as Evaluation).rule_results.find((x) => x.ruleName === 'answers_the_ask')!;
}

async function capabilitiesRelevance(client: Client) {
  const caps = JSON.parse(resourceTextOf(await client.readResource({ uri: 'iris://capabilities' }))) as {
    judge: { relevance: { budget: { limitUsd: number; spentUsd: number; calls: number; refused: number; exhausted: boolean; resetsAt: string }; maxCallsPerRequest: number; redact: boolean; egress: string } };
  };
  return caps.judge.relevance;
}

const ASK = {
  input: 'Summarize the latest quarterly report for the board meeting',
  output: 'Revenue grew 12% on the quarter, margins held at 31%, and the board is asked to approve the hiring plan.',
};
/** The worst case the budget reserves for ASK, priced as the per-call cap prices it. */
const WORST = worstCaseJudgeCostUsd({ template: 'relevance', model: MODEL, input: ASK.input, output: ASK.output })!;

/* ------------------------------------------------------------------- tests */

describe('the relevance judge daily budget', () => {
  it('admits calls while the worst case fits, then withholds the judge, falls back to the lexical reading, logs once and shows it on health', async () => {
    // Room for exactly two calls: the second needs one actual plus one worst case, the third two actuals plus one.
    env({ IRIS_LLM_JUDGE_DAILY_BUDGET_USD: String(2 * ACTUAL + WORST - 0.000002) });
    const storage = await store();
    const warn = vi.fn();
    const { server, client } = await mcp(storage, warn);

    const first = await evaluate(client, ASK);
    const second = await evaluate(client, ASK);
    expect(first.judge?.score).toBe(0.9);
    expect(second.judge?.score).toBe(0.9);
    expect(providerCalls).toHaveLength(2);

    const third = await evaluate(client, ASK);
    expect(providerCalls).toHaveLength(2);
    expect(third.judge).toMatchObject({ withheld: 'daily_budget', costUsd: 0 });
    expect(third.judge?.error).toMatch(/daily judge budget has 0\.\d{4} of [\d.]+ USD left today \(UTC\)/);
    expect(third.judge?.error).toContain('IRIS_LLM_JUDGE_DAILY_BUDGET_USD');
    // The lexical reading decided, and it advises rather than gates.
    expect(third.kind).toBe('policy');
    expect(third.role).toBe('advisory');

    await evaluate(client, ASK);
    expect(providerCalls).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/daily budget .* is spent for tenant local/);

    const state = await capabilitiesRelevance(client);
    expect(state.budget).toMatchObject({ calls: 2, refused: 2, exhausted: true, resetsAt: nextUtcMidnight(new Date()) });
    // Spent is the two actual costs, not the reservations: each reservation was settled to what the call cost.
    expect(state.budget.spentUsd).toBeCloseTo((2 * toMicroUsd(ACTUAL)) / 1e6, 9);
    expect(state.budget.spentUsd).toBeLessThanOrEqual(state.budget.limitUsd);

    const health = await buildHealth({ storage, relevanceJudge: () => server.evalEngine.relevanceJudgeInForce() });
    expect(health.body.judge.relevance).toEqual({ configured: true, ready: true, budget_exhausted: true, budget_resets_at: nextUtcMidnight(new Date()) });
  });

  it('is kept in the database: a new server on the same file starts from what was spent, not from zero', async () => {
    env({ IRIS_LLM_JUDGE_DAILY_BUDGET_USD: String(2 * ACTUAL + WORST - 0.000002) });
    const file = join(dir, 'restart.db');
    {
      const storage = await store(file);
      const { client } = await mcp(storage);
      await evaluate(client, ASK);
      await evaluate(client, ASK);
      expect(providerCalls).toHaveLength(2);
      for (const o of open.splice(0).reverse()) await o.close();
    }
    const storage = await store(file);
    const { client } = await mcp(storage);
    expect((await capabilitiesRelevance(client)).budget).toMatchObject({ calls: 2 });
    const after = await evaluate(client, ASK);
    expect(after.judge?.withheld).toBe('daily_budget');
    expect(providerCalls).toHaveLength(2);
  });

  it('--self-test prints the budget and what this install spent today, read from its database', async () => {
    const file = join(dir, 'selftest.db');
    {
      const storage = await store(file);
      const { client } = await mcp(storage);
      await evaluate(client, ASK);
      await evaluate(client, ASK);
      for (const o of open.splice(0).reverse()) await o.close();
    }
    const before = { home: process.env.IRIS_HOME, db: process.env.IRIS_DB_PATH };
    process.env.IRIS_DB_PATH = file;
    const lines: string[] = [];
    try {
      await runSelfTest((l) => lines.push(l));
    } finally {
      process.env.IRIS_HOME = before.home;
      if (before.db === undefined) delete process.env.IRIS_DB_PATH;
      else process.env.IRIS_DB_PATH = before.db;
    }
    const line = lines.find((l) => l.includes(SELF_TEST_STEPS.judge))!;
    expect(line).toContain(`budget 1 USD a day per tenant (UTC), ${((2 * toMicroUsd(ACTUAL)) / 1e6).toFixed(4)} spent today`);
    expect(line).toMatch(/sends that input and the output to Anthropic/);
    expect(line).toContain('at most 20 judge calls per request');
  }, 60_000);

  it('0 stops every call before any spend', async () => {
    env({ IRIS_LLM_JUDGE_DAILY_BUDGET_USD: '0' });
    const { client } = await mcp(await store());
    expect((await evaluate(client, ASK)).judge?.withheld).toBe('daily_budget');
    expect(providerCalls).toHaveLength(0);
  });
});

describe('the per-request cap', () => {
  it('evaluate_runs judges the first N traces of a run and reads the rest lexically, and the summary says how many', async () => {
    env({ IRIS_RELEVANCE_JUDGE_MAX_CALLS_PER_REQUEST: '2' });
    const storage = await store();
    const { client } = await mcp(storage);
    for (let i = 0; i < 5; i++) {
      await storage.insertTrace(LOCAL_TENANT, { trace_id: `${i}`.padStart(32, 'a'), agent_name: 'bot', input: ASK.input, output: `${ASK.output} (${i})`, timestamp: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(), run_id: 'r1' });
    }
    const r = await client.callTool({ name: 'evaluate_runs', arguments: { run: 'r1' } });
    expect((r as { isError?: boolean }).isError, text(r)).toBeFalsy();
    const out = JSON.parse(text(r)) as { evaluated: number; summary: string; run: string };
    expect(out.evaluated).toBe(5);
    expect(providerCalls).toHaveLength(2);
    expect(out.summary).toMatch(/asked for 2 of them.*read the other 3 lexically/);

    const withheld = [];
    for (let i = 0; i < 5; i++) {
      const evals = await storage.getEvalsByTraceId(LOCAL_TENANT, `${i}`.padStart(32, 'a'));
      withheld.push(evals?.[0]?.rule_results.find((x) => x.ruleName === 'answers_the_ask')?.judge?.withheld ?? null);
    }
    expect(withheld.filter((w) => w === 'request_cap')).toHaveLength(3);
  });

  it('an OTLP batch judges at most N traces, says so per trace, and reports the counts', async () => {
    env({ IRIS_RELEVANCE_JUDGE_MAX_CALLS_PER_REQUEST: '3' });
    const storage = await store();
    const config: IrisConfig = { ...defaultConfig, dashboard: { ...defaultConfig.dashboard, port: 0 }, otel: { evaluateOnIngest: true } };
    const engine = new EvalEngine(config.eval.defaultThreshold, config.eval.ruleThresholds, config.eval);
    engine.setRelevanceJudge(relevanceJudgeFromEnv({ ledger: storage.judgeSpendLedger() }));
    const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    const server: Server = createDashboardServer(storage, config, quiet, { evalEngine: engine }).start();
    await new Promise((r) => server.once('listening', r));
    open.push({ close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) });
    const port = (server.address() as { port: number }).port;

    const kv = (key: string, value: string) => ({ key, value: { stringValue: value } });
    const t0 = BigInt(Date.UTC(2026, 8, 21, 12)) * 1_000_000n;
    const spans = Array.from({ length: 8 }, (_, i) => ({
      traceId: (i + 1).toString(16).padStart(32, '0'),
      spanId: (i + 1).toString(16).padStart(16, '0'),
      name: 'chat',
      startTimeUnixNano: t0.toString(),
      endTimeUnixNano: (t0 + 1_000_000n).toString(),
      attributes: [kv('gen_ai.request.model', 'gpt-4o'), kv('gen_ai.input.messages', ASK.input), kv('gen_ai.output.messages', `${ASK.output} [${i}]`)],
    }));
    const res = await realFetch(`http://127.0.0.1:${port}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceSpans: [{ resource: { attributes: [kv('service.name', 'support-bot')] }, scopeSpans: [{ spans }] }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { 'iris-eval': { count: number; stored: Array<{ evaluation: Evaluation }>; relevance_judge: Record<string, number> } };
    expect(body['iris-eval'].count).toBe(8);
    expect(body['iris-eval'].relevance_judge).toEqual({ calls: 3, withheld: 5, max_calls_per_request: 3 });
    expect(providerCalls).toHaveLength(3);
    const reasons = body['iris-eval'].stored.map((s) => s.evaluation.rule_results.find((x) => x.ruleName === 'answers_the_ask')?.judge?.withheld ?? 'judged');
    expect(reasons).toEqual(['judged', 'judged', 'judged', 'request_cap', 'request_cap', 'request_cap', 'request_cap', 'request_cap']);
  });
});

describe('what reaches the provider', () => {
  const LEAKY = {
    input: 'Which plan is the account for jane.doe@acme-corp.io on? Its key is sk-live_4f9Qz8Lm2Xw7Rt5Yp3Nk6Vb1 if you need it.',
    output: 'The account for jane.doe@acme-corp.io is on the Team plan; I checked with AKIAIOSFODNN7EXAMPLF.',
  };
  const SECRETS = ['jane.doe@acme-corp.io', 'sk-live_4f9Qz8Lm2Xw7Rt5Yp3Nk6Vb1', '4f9Qz8Lm2Xw7Rt5Yp3Nk6Vb1', 'AKIAIOSFODNN7EXAMPLF'];

  it('by default the request body carries numbered markers in place of what no_pii flags, the same value the same marker', async () => {
    const { client } = await mcp(await store());
    const result = await evaluate(client, LEAKY);
    expect(providerCalls).toHaveLength(1);
    const wire = JSON.stringify(providerCalls[0].body);
    for (const secret of SECRETS) expect(wire).not.toContain(secret);
    const prompt = providerCalls[0].body.messages[0].content;
    expect(prompt.split('[REDACTED:Email#1]')).toHaveLength(3);
    expect(prompt).toContain('[REDACTED:API Key#1]');
    expect(prompt).toContain('[REDACTED:AWS Access Key#1]');
    expect(prompt).toContain('Which plan is the account for');
    expect(providerCalls[0].body.system).toMatch(/\[REDACTED:<kind>#<n>\]/);
    expect(result.judge?.redacted).toEqual({ Email: 2, 'API Key': 1, 'AWS Access Key': 1 });
    expect(result.judge?.sentUnredacted).toBeUndefined();
    expect((await capabilitiesRelevance(client)).egress).toMatch(/Anthropic.*no_pii.*replaced/);
  });

  it('with IRIS_RELEVANCE_JUDGE_REDACT=off the text goes as it is, and the record says so', async () => {
    env({ IRIS_RELEVANCE_JUDGE_REDACT: 'off' });
    const { client } = await mcp(await store());
    const result = await evaluate(client, LEAKY);
    const prompt = providerCalls[0].body.messages[0].content;
    for (const secret of SECRETS) expect(prompt).toContain(secret);
    expect(prompt).not.toContain('[REDACTED:');
    expect(result.judge?.sentUnredacted).toBe(true);
    expect(result.judge?.redacted).toBeUndefined();
    expect((await capabilitiesRelevance(client)).egress).toMatch(/UNREDACTED/);
  });

  it('an unrecognised value keeps redaction on and says so', async () => {
    env({ IRIS_RELEVANCE_JUDGE_REDACT: 'of' });
    const { client } = await mcp(await store());
    await evaluate(client, LEAKY);
    expect(providerCalls[0].body.messages[0].content).not.toContain('jane.doe@acme-corp.io');
    const state = JSON.parse(resourceTextOf(await client.readResource({ uri: 'iris://capabilities' }))) as { judge: { relevance: { notes: string[]; redact: boolean } } };
    expect(state.judge.relevance.redact).toBe(true);
    expect(state.judge.relevance.notes.join(' ')).toMatch(/IRIS_RELEVANCE_JUDGE_REDACT="of" is neither on nor off/);
  });
});

describe('a relevance judge that is configured and cannot run is loud, not silent', () => {
  async function selfTest(): Promise<{ code: number; out: string }> {
    const before = { home: process.env.IRIS_HOME, db: process.env.IRIS_DB_PATH };
    const lines: string[] = [];
    try {
      const code = await runSelfTest((l) => lines.push(l));
      return { code, out: lines.join('\n') };
    } finally {
      process.env.IRIS_HOME = before.home;
      if (before.db === undefined) delete process.env.IRIS_DB_PATH;
      else process.env.IRIS_DB_PATH = before.db;
    }
  }

  for (const [label, setup, missing] of [
    ['no key for its provider', () => delete process.env.IRIS_ANTHROPIC_API_KEY, /no IRIS_ANTHROPIC_API_KEY reached this process/],
    ['a model with no price', () => env({ IRIS_RELEVANCE_JUDGE_MODEL: 'gpt-9-imaginary' }), /"gpt-9-imaginary", which is not in the pricing table/],
  ] as const) {
    it(`${label}: one warning line at startup, a failed self-test, and each result says it fell back`, async () => {
      setup();
      const warn = vi.fn();
      const { client } = await mcp(await store(), warn);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/^Relevance judge is configured but cannot run: /);
      expect(warn.mock.calls[0][0]).toMatch(missing);
      expect(warn.mock.calls[0][0]).toMatch(/off-topic answer passes/);

      const result = await evaluate(client, { input: ASK.input, output: 'Bananas are yellow and grow in bunches on tall plants.' });
      expect(result.judge?.error).toMatch(missing);
      expect(result.role).toBe('advisory');
      expect(providerCalls).toHaveLength(0);

      const { code, out } = await selfTest();
      expect(code).toBe(1);
      expect(out).toMatch(new RegExp(`✗ ${SELF_TEST_STEPS.judge} — .*relevance judge configured but not callable`));
      expect(out).toContain(`${SELF_TEST_FAIL_VERDICT} — failed at: ${SELF_TEST_STEPS.judge}`);
    }, 60_000);
  }

  it('iris-eval ingest says it too, on stderr', async () => {
    delete process.env.IRIS_ANTHROPIC_API_KEY;
    const before = process.env.IRIS_DB_PATH;
    process.env.IRIS_DB_PATH = join(dir, 'ingest.db');
    let err = '';
    const sink = (onChunk: (s: string) => void) => new Writable({ write(chunk, _e, cb) { onChunk(String(chunk)); cb(); } });
    try {
      await runIngest({ cliArgs: {}, evaluate: true, source: 'cli', stdin: Readable.from([JSON.stringify({ agent_name: 'bot', ...ASK }) + '\n']), stdout: sink(() => {}), stderr: sink((s) => (err += s)) });
    } finally {
      if (before === undefined) delete process.env.IRIS_DB_PATH;
      else process.env.IRIS_DB_PATH = before;
    }
    expect(err).toMatch(/Relevance judge is configured but cannot run: .*no IRIS_ANTHROPIC_API_KEY/);
  });

  it('a judge that can run warns about nothing', async () => {
    const warn = vi.fn();
    await mcp(await store(), warn);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('tool annotations tell the truth about the network', () => {
  const annotations = async (client: Client) =>
    Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.annotations ?? {}]));

  it('with a relevance judge, the tools that may call it are open-world, and evaluate_output is not idempotent', async () => {
    const a = await annotations((await mcp(await store())).client);
    for (const name of ['evaluate_output', 'log_trace', 'evaluate_runs']) expect(a[name]?.openWorldHint, name).toBe(true);
    expect(a.evaluate_output?.idempotentHint).toBe(false);
  });

  it('without one they stay closed-world, whatever key is present', async () => {
    delete process.env.IRIS_RELEVANCE_JUDGE_MODEL;
    const a = await annotations((await mcp(await store())).client);
    for (const name of ['evaluate_output', 'log_trace', 'evaluate_runs']) expect(a[name]?.openWorldHint, name).toBe(false);
    expect(a.evaluate_output?.idempotentHint).toBe(true);
    expect(a.evaluate_with_llm_judge?.openWorldHint).toBe(true);
  });
});
