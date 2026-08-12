import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import type { Trace } from '../../../src/types/trace.js';
import type { EvalResult } from '../../../src/types/eval.js';

/*
 * getEvalStats counted a different population than every other scan.
 *
 * The headline aggregate filtered `AND trace_id IS NOT NULL` while the
 * trend, per-rule breakdown and failures queries did not: 3 linked +
 * 1 unlinked eval showed totalEvals 3 on the Health view while the trend
 * chart summed 4 and the failures list surfaced the unlinked failure the
 * headline pretended didn't exist. Worse, eval_results.trace_id is
 * ON DELETE SET NULL — deleting a trace retroactively shrank the headline
 * while every other number kept the eval.
 *
 * evaluate_output without a trace_id is documented and normal; the fix is
 * one population everywhere: every eval in the window.
 */

let tmpDir: string;
let adapter: SqliteAdapter;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'iris-evalpop-'));
  adapter = new SqliteAdapter(join(tmpDir, 'iris.db'));
  await adapter.initialize();
});

afterEach(async () => {
  await adapter.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEval(id: string, opts: { traceId?: string; passed: boolean }): EvalResult {
  return {
    id,
    trace_id: opts.traceId,
    eval_type: 'completeness',
    output_text: `output for ${id}`,
    score: opts.passed ? 1 : 0,
    passed: opts.passed,
    rule_results: [{ ruleName: 'response_length', passed: opts.passed, score: opts.passed ? 1 : 0, message: 'm' }],
    suggestions: [],
  };
}

async function insertScenario(): Promise<void> {
  const trace: Trace = {
    trace_id: 'trace-linked',
    agent_name: 'agent-a',
    framework: 'mcp',
    input: 'in',
    output: 'out',
    cost_usd: 0.001,
    latency_ms: 100,
    timestamp: new Date(Date.now() - 60_000).toISOString(),
  };
  await adapter.insertTrace(LOCAL_TENANT, trace);
  // 3 linked (2 pass, 1 fail) + 1 unlinked (fail) — the exact issue #333 shape.
  await adapter.insertEvalResult(LOCAL_TENANT, makeEval('e-l1', { traceId: trace.trace_id, passed: true }));
  await adapter.insertEvalResult(LOCAL_TENANT, makeEval('e-l2', { traceId: trace.trace_id, passed: true }));
  await adapter.insertEvalResult(LOCAL_TENANT, makeEval('e-l3', { traceId: trace.trace_id, passed: false }));
  await adapter.insertEvalResult(LOCAL_TENANT, makeEval('e-unlinked', { passed: false }));
}

describe('eval-stats population — one population everywhere', () => {
  it('counts 3 linked + 1 unlinked as totalEvals 4, agreeing with the trend sum', async () => {
    await insertScenario();

    const stats = await adapter.getEvalStats(LOCAL_TENANT, '24h');
    expect(stats.totalEvals).toBe(4);
    expect(stats.passRate).toBe(0.5); // 2 of 4, not 2 of 3

    const trend = await adapter.getEvalStatsTrend(LOCAL_TENANT, '24h');
    const trendTotal = trend.reduce((acc, b) => acc + b.evalCount, 0);
    expect(trendTotal).toBe(4);
    expect(stats.totalEvals).toBe(trendTotal);
  });

  it('surfaces the unlinked failure in the failures scan AND the headline', async () => {
    await insertScenario();

    const failures = await adapter.getEvalStatsFailures(LOCAL_TENANT, '24h', 10);
    expect(failures).toHaveLength(2);
    // The unlinked failure was always in this list — the headline just
    // used to deny it existed.
    expect(failures.some((f) => f.traceId === '')).toBe(true);

    const stats = await adapter.getEvalStats(LOCAL_TENANT, '24h');
    expect(stats.totalEvals).toBe(4);
  });

  it('keeps the headline stable when trace deletion SET NULLs the links', async () => {
    await insertScenario();

    // ON DELETE SET NULL fires: all 3 linked evals become unlinked.
    const deleted = await adapter.deleteTracesOlderThan(LOCAL_TENANT, 0);
    expect(deleted).toBe(1);

    const stats = await adapter.getEvalStats(LOCAL_TENANT, '24h');
    // The evals still happened. Before the fix this dropped 4 -> 0.
    expect(stats.totalEvals).toBe(4);
    expect(stats.passRate).toBe(0.5);
  });
});
