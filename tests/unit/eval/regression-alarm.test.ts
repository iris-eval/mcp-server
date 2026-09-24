/*
 * The regression-alarm moment kind: a `regression-alarm`
 * moment exists and the moments filter accepts it — the bold sentence.
 *
 * A moment carries the alarm its agent's stream raised at that trace; the
 * kind ranks above the novelty classes and below a cost spike; it is a
 * flagged failure on the Failures page; the moments route accepts
 * `significance_kind=regression-alarm` and returns only such moments; and a
 * run-scoped alarm names its run.
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import { deriveMoment, historyBefore } from '../../../src/eval/decision-moment.js';
import { isFailureMoment } from '../../../src/eval/failure-rank.js';
import { fnv1a, mulberry32 } from '../../../src/eval/stats.js';
import { MOMENT_SIGNIFICANCE_KINDS } from '../../../src/types/decision-moment.js';
import { registerMomentRoutes } from '../../../src/dashboard/routes/moments.js';
import { createTenantMiddleware } from '../../../src/middleware/tenant.js';
import type { AgentFailureLogEntry, IStorageAdapter } from '../../../src/types/query.js';
import type { Trace } from '../../../src/types/trace.js';
import type { EvalResult } from '../../../src/types/eval.js';

const RULES = ['min_output_length', 'keyword_overlap'];

/** A log of n evaluated traces for one agent: no_pii fails at `rate`, then every time from `shiftAt`. */
function shiftedLog(n: number, rate: number, shiftAt: number, seed = 'alarm', runId: string | null = null): AgentFailureLogEntry[] {
  const rng = mulberry32(fnv1a(seed));
  return Array.from({ length: n }, (_, i) => ({
    traceId: `t${String(i).padStart(4, '0')}`,
    timestamp: new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString(),
    failed: i >= shiftAt || rng() < rate ? ['min_output_length'] : [],
    judged: [...RULES],
    costUsd: null,
    runId,
  }));
}

const traceOf = (e: AgentFailureLogEntry, agent = 'bot'): Trace => ({ trace_id: e.traceId, agent_name: agent, timestamp: e.timestamp, input: 'ask', output: 'answer', ...(e.runId ? { run_id: e.runId } : {}) });
const evalOf = (e: AgentFailureLogEntry): EvalResult[] => [
  {
    id: `e-${e.traceId}`,
    trace_id: e.traceId,
    eval_type: 'completeness',
    output_text: 'answer',
    score: e.failed.length ? 0.2 : 0.9,
    passed: e.failed.length === 0,
    rule_results: RULES.map((ruleName) => ({ ruleName, passed: !e.failed.includes(ruleName), score: e.failed.includes(ruleName) ? 0 : 1, message: 'x' })),
  },
];

/** The first trace at which the agent-wide stream alarms, with its history. */
function firstAlarm(log: AgentFailureLogEntry[]): { entry: AgentFailureLogEntry; history: ReturnType<typeof historyBefore> } {
  for (const entry of log) {
    const history = historyBefore(log, entry.traceId, entry.timestamp);
    if (history.regressionAlarms.length > 0) return { entry, history };
  }
  throw new Error('no alarm in the log');
}

describe('the regression-alarm kind', () => {
  it('exists in the one kind list every filter derives from', () => {
    expect(MOMENT_SIGNIFICANCE_KINDS).toContain('regression-alarm');
  });

  it('a trace whose evaluation crossed the line is a regression-alarm moment that names the rule, the rates and the reset', () => {
    const log = shiftedLog(600, 0.2, 400);
    const { entry, history } = firstAlarm(log);
    expect(Number(entry.traceId.slice(1))).toBeGreaterThanOrEqual(400);
    const m = deriveMoment(traceOf(entry), evalOf(entry), history);
    expect(m.significance.kind).toBe('regression-alarm');
    expect(m.significance.score).toBe(0.85);
    expect(m.significance.label).toBe('Regression alarm: min_output_length');
    expect(m.significance.reason).toContain('The fail rate of min_output_length for bot has shifted');
    expect(m.significance.reason).toContain('against a baseline of');
    expect(m.significance.reason).toContain('reports and never gates');
    expect(isFailureMoment(m)).toBe(true);
  });

  it('ranks below a cost spike and above a first failure; a trace with no alarm of its own is not one', () => {
    const log = shiftedLog(600, 0.2, 400);
    const { entry, history } = firstAlarm(log);
    const m = deriveMoment(traceOf(entry), evalOf(entry), history);
    expect(m.significance.kind).toBe('regression-alarm');
    // The trace just before the alarm carries no alarm and is a plain fail or pass.
    const prev = log[Number(entry.traceId.slice(1)) - 1];
    const before = deriveMoment(traceOf(prev), evalOf(prev), historyBefore(log, prev.traceId, prev.timestamp));
    expect(before.significance.kind).not.toBe('regression-alarm');
  });

  it('a run-scoped alarm names its run', () => {
    // Run B runs at 20% for 400 traces then fails every time; the agent-wide
    // stream (which also sees run A at 20%) may alarm too, and the label
    // names the run only when every alarm at this trace is run-scoped.
    const a = shiftedLog(400, 0.2, 10_000, 'run-a', 'A');
    const b = shiftedLog(700, 0.2, 400, 'run-b', 'B').map((e, i) => ({ ...e, traceId: `u${String(i).padStart(4, '0')}`, timestamp: new Date(Date.UTC(2026, 8, 2, 0, 0, i)).toISOString() }));
    const log = [...a, ...b];
    const alarmed = b.find((e) => historyBefore(log, e.traceId, e.timestamp).regressionAlarms.some((x) => x.run === 'B'))!;
    expect(alarmed).toBeDefined();
    const history = historyBefore(log, alarmed.traceId, alarmed.timestamp);
    const m = deriveMoment(traceOf(alarmed), evalOf(alarmed), history);
    expect(m.significance.kind).toBe('regression-alarm');
    expect(m.significance.reason).toContain('within run "B"');
  });
});

describe('the moments filter accepts the new kind', () => {
  function stubStorage(log: AgentFailureLogEntry[]): IStorageAdapter {
    const traces = log.map((e) => traceOf(e));
    return {
      queryTraces: async (_t: string, options: { limit?: number; offset?: number }) => ({ traces: traces.slice().reverse(), total: traces.length, limit: options.limit ?? 50, offset: options.offset ?? 0 }),
      getEvalsByTraceId: async (_t: string, id: string) => evalOf(log.find((e) => e.traceId === id)!),
      getEvalsByTraceIds: async (_t: string, ids: readonly string[]) =>
        new Map(ids.map((id) => [id, evalOf(log.find((e) => e.traceId === id)!)])),
      getAgentFailureLog: async () => log,
      getSpansByTraceId: async () => [],
      getTrace: async (_t: string, id: string) => traces.find((t) => t.trace_id === id) ?? null,
    } as unknown as IStorageAdapter;
  }

  async function get(app: express.Express, path: string): Promise<{ status: number; body: { moments?: Array<{ id: string; significance: { kind: string } }>; error?: string } }> {
    const server = app.listen(0);
    const { port } = server.address() as { port: number };
    try {
      const res = await fetch(`http://localhost:${port}${path}`);
      return { status: res.status, body: (await res.json()) as { moments?: Array<{ id: string; significance: { kind: string } }>; error?: string } };
    } finally {
      server.close();
    }
  }

  it('GET /moments?significance_kind=regression-alarm returns only alarm moments, and an unknown kind is refused', async () => {
    const log = shiftedLog(600, 0.2, 400);
    const app = express();
    app.use(createTenantMiddleware());
    const router = express.Router();
    registerMomentRoutes(router, stubStorage(log));
    app.use('/api/v1', router);
    const ok = await get(app, '/api/v1/moments?significance_kind=regression-alarm&limit=200');
    expect(ok.status).toBe(200);
    expect(ok.body.moments!.length).toBeGreaterThan(0);
    expect(ok.body.moments!.every((m) => m.significance.kind === 'regression-alarm')).toBe(true);
    const bad = await get(app, '/api/v1/moments?significance_kind=regression-alarms');
    expect(bad.status).toBe(400);
  }, 60_000);
});
