/*
 * The read side of a comparison over HTTP.
 *
 * The property these three routes exist to hold: /runs/:id collapses to one
 * evaluation per trace, because "how did this run do" must not weight a
 * re-evaluated case twice — and /cases/:key deliberately does NOT, because
 * there the repetition is the measurement. A single "list the evaluations"
 * route would have to pick one, and would be wrong for the other question.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { SqliteAdapter } from '../../../../src/storage/sqlite-adapter.js';
import { createDashboardServer } from '../../../../src/dashboard/server.js';
import { defaultConfig } from '../../../../src/config/defaults.js';
import { createLogger } from '../../../../src/utils/logger.js';
import { EvalEngine } from '../../../../src/eval/engine.js';
import { LOCAL_TENANT } from '../../../../src/types/tenant.js';
import type { EvalResult } from '../../../../src/types/eval.js';

describe('the runs and cases routes', () => {
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
    ...over,
  });

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const config = structuredClone(defaultConfig);
    config.dashboard.port = 0;
    config.dashboard.host = '127.0.0.1';
    config.logging.level = 'error';
    const evalEngine = new EvalEngine(config.eval.defaultThreshold, config.eval.ruleThresholds, config.eval);
    server = createDashboardServer(storage, config, createLogger(config), { evalEngine }).start();
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    port = (server.address() as { port: number }).port;

    for (const [traceId, caseKey] of [
      ['t1', 'case-a'],
      ['t2', 'case-b'],
    ] as const) {
      await storage.insertTrace(LOCAL_TENANT, {
        trace_id: traceId,
        agent_name: 'runner',
        input: `ask ${traceId}`,
        output: `answer ${traceId}`,
        timestamp: '2026-09-01T10:00:00Z',
        run_id: 'nightly-1',
        case_key: caseKey,
      });
    }
    await storage.insertEvalResult(LOCAL_TENANT, evalRow('e1', 't1', true));
    await storage.insertEvalResult(LOCAL_TENANT, evalRow('e2', 't2', false));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await storage.close();
  });

  const get = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('lists a run nothing registered, counted from its rows', async () => {
    const { status, body } = await get('/runs');
    expect(status).toBe(200);
    const runs = body.runs as Array<{ runId: string; traces: number; evaluated: number; passed: number; label: string | null }>;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId: 'nightly-1', traces: 2, evaluated: 2, passed: 1, label: null });
  });

  it('collapses a re-evaluated trace to one row, so a run is never counted twice', async () => {
    // Second evaluation of t1 — the same case scored again.
    await storage.insertEvalResult(LOCAL_TENANT, evalRow('e3', 't1', false));

    const { body } = await get('/runs/nightly-1');
    const results = body.results as Array<{ traceId: string; supersededInRun?: number }>;
    expect(results).toHaveLength(2);
    expect(new Set(results.map((r) => r.traceId))).toEqual(new Set(['t1', 't2']));
    // The one that was dropped is reported, not silently discarded.
    expect(results[0].supersededInRun).toBe(1);
  });

  it('404s a run nothing mentions', async () => {
    expect((await get('/runs/never-ran')).status).toBe(404);
  });

  it('keeps every attempt at a case, because the repetition is the measurement', async () => {
    await storage.insertEvalResult(LOCAL_TENANT, evalRow('e3', 't1', false));

    const { status, body } = await get('/cases/case-a');
    expect(status).toBe(200);
    expect(body).toMatchObject({ caseKey: 'case-a', attempts: 2, passed: 1, flaky: true });
    expect(body.runs).toEqual(['nightly-1']);
  });

  it('a case answered the same way every time is not flaky', async () => {
    const { body } = await get('/cases/case-b');
    expect(body).toMatchObject({ attempts: 1, passed: 0, flaky: false });
  });

  it('404s a case key nothing carries', async () => {
    expect((await get('/cases/case-nonexistent')).status).toBe(404);
  });

  it('splits the trend by run only when asked, and leaves the old response shape alone', async () => {
    const plain = (await get('/eval-stats/trend?period=all')).body as unknown as Array<Record<string, unknown>>;
    expect(plain.length).toBeGreaterThan(0);
    expect(plain[0]).not.toHaveProperty('cohort');

    const split = (await get('/eval-stats/trend?period=all&cohort=run')).body as unknown as Array<{ cohort: string | null }>;
    expect(split.length).toBeGreaterThan(0);
    expect(split.every((b) => b.cohort === 'nightly-1')).toBe(true);
  });

  it('refuses a cohort it does not know rather than reaching SQL with it', async () => {
    const { status } = await get('/eval-stats/trend?cohort=agent_name');
    expect(status).toBe(400);
  });
});
