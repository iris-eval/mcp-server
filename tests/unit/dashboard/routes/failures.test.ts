/*
 * Route tests for GET /failures — the ranked failure list behind the
 * dashboard's landing view.
 *
 * Uses a stub storage adapter seeded with traces whose derived moments
 * cover every branch: clean pass (excluded), plain fail, partial,
 * safety violation, cost-spike-on-pass (flagged), unevaluated
 * (excluded). Moments are derived by the REAL deriveMoment inside the
 * route, so these fixtures exercise the production classification path,
 * not a parallel one.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import { registerFailureRoutes } from '../../../../src/dashboard/routes/failures.js';
import { createTenantMiddleware } from '../../../../src/middleware/tenant.js';
import { LOCAL_TENANT } from '../../../../src/types/tenant.js';
import type { IStorageAdapter } from '../../../../src/types/query.js';
import type { Trace } from '../../../../src/types/trace.js';
import type { EvalResult } from '../../../../src/types/eval.js';
import type { RankedFailure } from '../../../../src/types/decision-moment.js';

function makeTrace(id: string, overrides: Partial<Trace> = {}): Trace {
  return {
    trace_id: id,
    agent_name: 'test-agent',
    timestamp: new Date().toISOString(),
    input: 'Hello',
    output: 'Hi there',
    cost_usd: 0.001,
    latency_ms: 250,
    ...overrides,
  };
}

function makeEval(traceId: string, overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    id: `eval-${traceId}`,
    trace_id: traceId,
    eval_type: 'safety',
    output_text: 'Hi there',
    score: 1,
    passed: true,
    rule_results: [],
    suggestions: [],
    ...overrides,
  };
}

const passRules = [{ ruleName: 'min_output_length', passed: true, score: 1, message: 'OK' }];
const failRules = [{ ruleName: 'min_output_length', passed: false, score: 0, message: 'Too short' }];
const piiRules = [{ ruleName: 'no_pii', passed: false, score: 0, message: 'SSN detected' }];

interface StubData {
  traces: Trace[];
  evalsByTrace: Record<string, EvalResult[]>;
}

/**
 * Stub adapter that records every tenantId it receives, so tests can
 * prove tenancy is threaded through both storage calls the route makes.
 */
function makeStubStorage(data: StubData): {
  storage: IStorageAdapter;
  seenTenants: string[];
  seenQueries: Array<{ limit?: number; agent_name?: string }>;
} {
  const seenTenants: string[] = [];
  const seenQueries: Array<{ limit?: number; agent_name?: string }> = [];
  const storage = {
    queryTraces: async (tenantId: string, options: { limit?: number; filter?: { agent_name?: string } }) => {
      seenTenants.push(tenantId);
      seenQueries.push({ limit: options.limit, agent_name: options.filter?.agent_name });
      return {
        traces: data.traces,
        total: data.traces.length,
        limit: options.limit ?? 50,
        offset: 0,
      };
    },
    getEvalsByTraceId: async (tenantId: string, traceId: string) => {
      seenTenants.push(tenantId);
      return data.evalsByTrace[traceId] ?? [];
    },
  } as unknown as IStorageAdapter;
  return { storage, seenTenants, seenQueries };
}

function makeApp(storage: IStorageAdapter, { withTenant = true } = {}) {
  const app = express();
  if (withTenant) app.use(createTenantMiddleware());
  const router = express.Router();
  registerFailureRoutes(router, storage);
  app.use('/api/v1', router);
  return app;
}

async function request(
  app: express.Express,
  path: string,
): Promise<{ status: number; body: { failures: RankedFailure[]; scanned: number; total: number; limit: number } }> {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  try {
    const res = await fetch(`http://localhost:${addr.port}${path}`);
    const body = res.status === 200 ? await res.json() : await res.json().catch(() => ({}));
    return { status: res.status, body };
  } finally {
    server.close();
  }
}

/** Fixture where all four failure shapes plus two excluded shapes exist. */
function mixedFixture(): StubData {
  const now = Date.now();
  const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();
  return {
    traces: [
      makeTrace('t-pass', { timestamp: hourAgo }),
      makeTrace('t-fail', { timestamp: hourAgo }),
      makeTrace('t-partial', { timestamp: hourAgo }),
      makeTrace('t-safety', { timestamp: hourAgo }),
      makeTrace('t-costspike', { timestamp: hourAgo, cost_usd: 0.15 }),
      makeTrace('t-unevaluated', { timestamp: hourAgo }),
    ],
    evalsByTrace: {
      't-pass': [makeEval('t-pass', { rule_results: passRules })],
      't-fail': [makeEval('t-fail', { passed: false, score: 0, rule_results: failRules })],
      't-partial': [
        makeEval('t-partial', {
          passed: false,
          rule_results: [...failRules, ...passRules],
        }),
      ],
      't-safety': [makeEval('t-safety', { passed: false, score: 0, rule_results: piiRules })],
      't-costspike': [makeEval('t-costspike', { rule_results: passRules })],
      't-unevaluated': [],
    },
  };
}

describe('GET /failures', () => {
  it('returns failed + flagged moments and excludes clean passes and unevaluated traces', async () => {
    const { storage } = makeStubStorage(mixedFixture());
    const res = await request(makeApp(storage), '/api/v1/failures');

    expect(res.status).toBe(200);
    const ids = res.body.failures.map((f) => f.id);
    expect(ids).toHaveLength(4);
    expect(ids).toContain('t-fail');
    expect(ids).toContain('t-partial');
    expect(ids).toContain('t-safety');
    expect(ids).toContain('t-costspike'); // pass verdict, but cost-flagged
    expect(ids).not.toContain('t-pass');
    expect(ids).not.toContain('t-unevaluated');
    expect(res.body.scanned).toBe(6);
    expect(res.body.total).toBe(6);
  });

  it('each row carries what the landing list renders: rule, agent, trace, when, rank', async () => {
    const { storage } = makeStubStorage(mixedFixture());
    const res = await request(makeApp(storage), '/api/v1/failures');

    const fail = res.body.failures.find((f) => f.id === 't-fail');
    expect(fail).toBeDefined();
    expect(fail!.agentName).toBe('test-agent');
    expect(fail!.traceId).toBe('t-fail');
    expect(fail!.ruleSnapshot.failed).toEqual(['min_output_length']);
    expect(typeof fail!.timestamp).toBe('string');
    expect(fail!.rankScore).toBeGreaterThan(0);
    expect(fail!.rankScore).toBeLessThanOrEqual(1);
  });

  it('ranks by severity × recency: same-age failures order safety > cost > fail', async () => {
    const { storage } = makeStubStorage(mixedFixture());
    const res = await request(makeApp(storage), '/api/v1/failures');

    const ids = res.body.failures.map((f) => f.id);
    // Same timestamp → pure severity order: safety 1.0, cost-spike 0.9,
    // fail 0.5, partial 0.4 (scores from classifySignificance).
    expect(ids).toEqual(['t-safety', 't-costspike', 't-fail', 't-partial']);
    const scores = res.body.failures.map((f) => f.rankScore);
    const sorted = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(sorted);
  });

  it('surfaces an hour-old plain fail above a three-day-old safety violation', async () => {
    const now = Date.now();
    const data: StubData = {
      traces: [
        makeTrace('t-old-safety', {
          timestamp: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
        }),
        makeTrace('t-new-fail', { timestamp: new Date(now - 60 * 60 * 1000).toISOString() }),
      ],
      evalsByTrace: {
        't-old-safety': [
          makeEval('t-old-safety', { passed: false, score: 0, rule_results: piiRules }),
        ],
        't-new-fail': [
          makeEval('t-new-fail', { passed: false, score: 0, rule_results: failRules }),
        ],
      },
    };
    const { storage } = makeStubStorage(data);
    const res = await request(makeApp(storage), '/api/v1/failures');

    expect(res.body.failures.map((f) => f.id)).toEqual(['t-new-fail', 't-old-safety']);
  });

  it('respects limit after ranking', async () => {
    const { storage } = makeStubStorage(mixedFixture());
    const res = await request(makeApp(storage), '/api/v1/failures?limit=2');

    expect(res.body.failures.map((f) => f.id)).toEqual(['t-safety', 't-costspike']);
    expect(res.body.limit).toBe(2);
    // scanned/total still reflect the full window, so the UI can tell
    // "no failures" apart from "no runs at all".
    expect(res.body.scanned).toBe(6);
  });

  it('scans wider than the returned limit so buried failures still surface', async () => {
    const { storage, seenQueries } = makeStubStorage(mixedFixture());
    await request(makeApp(storage), '/api/v1/failures?limit=1');

    // The trace scan must NOT shrink to the response limit — a failure
    // behind hundreds of passing traces would never surface again.
    expect(seenQueries[0].limit).toBeGreaterThan(1);
  });

  it('passes the agent_name filter through to storage', async () => {
    const { storage, seenQueries } = makeStubStorage(mixedFixture());
    await request(makeApp(storage), '/api/v1/failures?agent_name=test-agent');
    expect(seenQueries[0].agent_name).toBe('test-agent');
  });

  it('threads the tenant id into every storage call', async () => {
    const { storage, seenTenants } = makeStubStorage(mixedFixture());
    await request(makeApp(storage), '/api/v1/failures');

    expect(seenTenants.length).toBeGreaterThan(1); // queryTraces + per-trace eval fetches
    for (const t of seenTenants) expect(t).toBe(LOCAL_TENANT);
  });

  it('rejects invalid query parameters with 400', async () => {
    const { storage } = makeStubStorage(mixedFixture());
    const app = makeApp(storage);

    for (const bad of ['limit=0', 'limit=500', 'limit=abc', 'since=yesterday']) {
      const res = await request(app, `/api/v1/failures?${bad}`);
      expect(res.status, `expected 400 for ${bad}`).toBe(400);
    }
  });

  it('refuses when tenant middleware is not mounted (fail-closed gate)', async () => {
    const { storage } = makeStubStorage(mixedFixture());
    const res = await request(makeApp(storage, { withTenant: false }), '/api/v1/failures');
    expect(res.status).toBe(500);
  });
});
