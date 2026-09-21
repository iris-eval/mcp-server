/*
 * The five views (arc 8, R-9): each a parameterised read over a seeded
 * store with a documented row shape; an unknown name is 404; a parameter
 * outside its range, or one the view does not take, is 400.
 *
 * regression_alarms needs a stream long enough for CUSUM to settle a
 * baseline and then cross its line, which a seeded store would take
 * hundreds of rows to give; that view is exercised through a storage whose
 * failure log is the same shape the adapter returns, built the way the
 * CUSUM test builds its own.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import express from 'express';
import { SqliteAdapter } from '../../../../src/storage/sqlite-adapter.js';
import { createDashboardServer } from '../../../../src/dashboard/server.js';
import { registerViewRoutes, VIEW_NAMES } from '../../../../src/dashboard/routes/views.js';
import { createTenantMiddleware } from '../../../../src/middleware/tenant.js';
import { defaultConfig } from '../../../../src/config/defaults.js';
import { createLogger } from '../../../../src/utils/logger.js';
import { LOCAL_TENANT } from '../../../../src/types/tenant.js';
import type { EvalResult } from '../../../../src/types/eval.js';
import type { AgentFailureLogEntry, IStorageAdapter } from '../../../../src/types/query.js';

const NOW = Date.now();
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

describe('the views', () => {
  let storage: SqliteAdapter;
  let server: Server;
  let port = 0;

  const evalRow = (id: string, traceId: string, passed: boolean, over: Partial<EvalResult> = {}): EvalResult => ({
    id,
    trace_id: traceId,
    eval_type: 'all',
    output_text: 'answer',
    score: passed ? 0.9 : 0.2,
    passed,
    rule_results: [{ ruleName: 'min_output_length', passed, score: passed ? 1 : 0, message: 'm' }],
    suggestions: [],
    created_at: ago(5),
    ...over,
  });

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const config = structuredClone(defaultConfig);
    config.dashboard.port = 0;
    config.dashboard.host = '127.0.0.1';
    config.logging.level = 'error';
    server = createDashboardServer(storage, config, createLogger(config)).start();
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    port = (server.address() as { port: number }).port;

    // Agent a: three traces (0.10, 0.30, no cost); agent b: one trace (0.05).
    // Case k1 asked three times (pass, fail, pass) — flaky; k2 twice, both pass; k3 once, fail.
    const traces = [
      { id: 't1', agent: 'a', cost: 0.1, key: 'k1', run: 'r1', passed: true },
      { id: 't2', agent: 'a', cost: 0.3, key: 'k1', run: 'r2', passed: false },
      { id: 't3', agent: 'a', cost: undefined, key: 'k1', run: 'r2', passed: true },
      { id: 't4', agent: 'b', cost: 0.05, key: 'k2', run: 'r1', passed: true },
      { id: 't5', agent: 'b', cost: undefined, key: 'k2', run: 'r2', passed: true },
      { id: 't6', agent: 'b', cost: undefined, key: 'k3', run: 'r2', passed: false },
    ];
    for (const t of traces) {
      await storage.insertTrace(LOCAL_TENANT, {
        trace_id: t.id,
        agent_name: t.agent,
        input: `ask ${t.key}`,
        output: `answer ${t.id}`,
        timestamp: ago(10),
        run_id: t.run,
        case_key: t.key,
        ...(t.cost === undefined ? {} : { cost_usd: t.cost }),
      });
      await storage.insertEvalResult(LOCAL_TENANT, evalRow(`e-${t.id}`, t.id, t.passed));
    }
    // One evaluation whose safety question could not be judged: the rule was defeated.
    await storage.insertEvalResult(
      LOCAL_TENANT,
      evalRow('e-unjudged', 't1', true, {
        rule_results: [
          { ruleName: 'no_pii', passed: true, score: 1, message: 'skipped', skipped: true, skipClass: 'defeated', skipReason: 'sandbox budget', question: 'safe_output' },
          { ruleName: 'min_output_length', passed: true, score: 1, message: 'm', question: 'complete' },
        ] as EvalResult['rule_results'],
      }),
    );
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await storage.close();
  });

  const get = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('lists the five views with what each answers', async () => {
    const { status, body } = await get('/views');
    expect(status).toBe(200);
    expect(body.count).toBe(5);
    expect((body.views as Array<{ name: string; path: string; answers: string }>).map((v) => v.name)).toEqual([...VIEW_NAMES]);
    for (const v of body.views as Array<{ name: string; path: string; answers: string }>) {
      expect(v.path).toBe(`/api/v1/views/${v.name}`);
      expect(v.answers.length).toBeGreaterThan(20);
    }
  });

  it('failures_by_rule: the rules that failed, most failures first, with the envelope', async () => {
    const { status, body } = await get('/views/failures_by_rule?period=all');
    expect(status).toBe(200);
    expect(body).toMatchObject({ view: 'failures_by_rule', period: 'all', since: null, count: 1 });
    expect(body.params).toEqual({ limit: 50 });
    expect(typeof body.generated_at).toBe('string');
    const rows = body.rows as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ rule: 'min_output_length', failed: 2 });
    expect(rows[0].evaluated).toBeGreaterThanOrEqual(6);
    expect(typeof rows[0].passRate).toBe('number');
  });

  it('cost_by_agent: total, count of costed traces, average and max per agent, most expensive first; the period narrows', async () => {
    const { status, body } = await get('/views/cost_by_agent?period=all');
    expect(status).toBe(200);
    const rows = body.rows as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      { agent: 'a', traces: 3, costedTraces: 2, totalCostUsd: 0.4, avgCostUsd: 0.2, maxCostUsd: 0.3 },
      { agent: 'b', traces: 3, costedTraces: 1, totalCostUsd: 0.05, avgCostUsd: 0.05, maxCostUsd: 0.05 },
    ]);
    // A 24-hour window still holds traces from ten minutes ago, and the envelope names its start.
    const narrow = await get('/views/cost_by_agent?period=24h');
    expect(narrow.body.count).toBe(2);
    expect(typeof narrow.body.since).toBe('string');
  });

  it('flaky_cases: cases answered both ways with at least min_attempts, least reliable first, and the runs they span', async () => {
    const { status, body } = await get('/views/flaky_cases');
    expect(status).toBe(200);
    expect(body.params).toEqual({ limit: 50, min_attempts: 2 });
    // k1 was asked three times, and t1 carries a second evaluation (the unjudged one): four attempts, three passes — every attempt counts, as the cases route says.
    expect(body.rows).toEqual([{ caseKey: 'k1', attempts: 4, passed: 3, rate: 0.75, runs: ['r1', 'r2'] }]);
    // Narrowed to one run k1 is asked twice with one pass — still flaky; k3's lone fail never is.
    const r2 = await get('/views/flaky_cases?run=r2');
    expect(r2.body.rows).toEqual([{ caseKey: 'k1', attempts: 2, passed: 1, rate: 0.5, runs: ['r2'] }]);
    expect((await get('/views/flaky_cases?min_attempts=5')).body.count).toBe(0);
  });

  it('unjudged_questions: per question, how many evaluations the rules could not judge and the reasons named most', async () => {
    const { status, body } = await get('/views/unjudged_questions?period=all');
    expect(status).toBe(200);
    const rows = body.rows as Array<{ question: string; unjudged: number; judged: number; notApplicable: number; reasons: Array<{ why: string; count: number }> }>;
    expect(rows[0].question).toBe('safe_output');
    expect(rows[0].unjudged).toBe(1);
    expect(rows[0].reasons[0].why).toMatch(/defeated: no_pii/);
    expect(rows[0].reasons[0].count).toBe(1);
    const complete = rows.find((r) => r.question === 'complete');
    expect(complete?.judged).toBe(1);
    expect(complete?.unjudged).toBe(0);
    expect(body.note).toMatch(/^scanned 7 evaluations$/);
  });

  it('regression_alarms: empty on a short store, with the agents walked in the note', async () => {
    const { status, body } = await get('/views/regression_alarms');
    expect(status).toBe(200);
    expect(body.rows).toEqual([]);
    expect(body.note).toBe('2 agents walked');
    expect((await get('/views/regression_alarms?agent=a')).body.note).toBe('1 agent walked');
  });

  it('an unknown view is 404 naming the five; a parameter outside its range, or one a view does not take, is 400', async () => {
    const unknown = await get('/views/everything');
    expect(unknown.status).toBe(404);
    expect(unknown.body.views).toEqual([...VIEW_NAMES]);
    expect((await get('/views/failures_by_rule?limit=0')).status).toBe(400);
    expect((await get('/views/failures_by_rule?limit=501')).status).toBe(400);
    expect((await get('/views/flaky_cases?min_attempts=0')).status).toBe(400);
    expect((await get('/views/cost_by_agent?period=1y')).status).toBe(400);
    expect((await get('/views/cost_by_agent?sql=1')).status).toBe(400);
  });
});

describe('regression_alarms over a stream that crossed its line', () => {
  it('flattens every alarm with the agent, the rule, the run, the trace and the sentence', async () => {
    // 200 evaluations failing no_pii one time in five, then 200 failing every time: the stream alarms on no_pii.
    const log: AgentFailureLogEntry[] = [];
    for (let i = 0; i < 400; i += 1) {
      const failed = i >= 200 || i % 5 === 0 ? ['no_pii'] : [];
      log.push({ traceId: `t${i}`, timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), failed, judged: ['no_pii', 'min_output_length'], costUsd: null, runId: null });
    }
    const storage = {
      getDistinctValues: async () => ['support-bot'],
      getAgentFailureLog: async () => [...log].reverse(), // newest first, as a reader might return it
    } as unknown as IStorageAdapter;
    const app = express();
    app.use(createTenantMiddleware());
    const router = express.Router();
    registerViewRoutes(router, storage);
    app.use('/api/v1', router);
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    try {
      const res = await fetch(`http://localhost:${addr.port}/api/v1/views/regression_alarms`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rows: Array<Record<string, unknown>>; count: number; note: string };
      expect(body.count).toBeGreaterThan(0);
      expect(body.note).toBe('1 agent walked');
      const alarm = body.rows[0];
      expect(alarm).toMatchObject({ agent: 'support-bot', rule: 'no_pii', run: null });
      expect(Number(String(alarm.traceId).slice(1))).toBeGreaterThanOrEqual(200);
      expect(alarm.baselineN).toBeGreaterThan(0);
      expect(alarm.monitoredFails).toBeGreaterThan(0);
      expect(String(alarm.sentence)).toContain('support-bot');
      expect(String(alarm.sentence)).toContain('no_pii');
    } finally {
      server.close();
    }
  }, 60_000);
});
