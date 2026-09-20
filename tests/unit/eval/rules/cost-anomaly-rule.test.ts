/*
 * cost_anomaly, the rule (H-5 of the 2026-09-20 audit; the approved §4.8).
 *
 * A measurement that reads the agent's own recent costs: skips without a
 * cost and below twenty prior costed traces; fires over the agent's own
 * baseline and not at a dollar figure; names the dearest call when the
 * trajectory prices its calls and the largest estimated share when it
 * does not; carries the stamp of a measurement (definition-based
 * uncertainty, advisory role) so it never decides the verdict. And the
 * engine's doors feed it the same history the moment classifier reads —
 * proven through the store-and-evaluate primitive on a real store.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { costAnomaly, costRules } from '../../../../src/eval/rules/cost.js';
import { COST_ANOMALY_MIN_HISTORY, COST_ANOMALY_Z } from '../../../../src/eval/cost-anomaly.js';
import { costHistoryFor, evaluateStoredTrace } from '../../../../src/eval/ingest.js';
import { SqliteAdapter } from '../../../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../../../src/server.js';
import { defaultConfig } from '../../../../src/config/defaults.js';
import { LOCAL_TENANT } from '../../../../src/types/tenant.js';
import type { EvalContext } from '../../../../src/types/eval.js';
import type { Trace } from '../../../../src/types/trace.js';

/** Twenty costs with median 0.010 and MAD 0.001. */
const A = [0.01, 0.011, 0.009, 0.012, 0.01, 0.011, 0.01, 0.009, 0.012, 0.011, 0.01, 0.01, 0.011, 0.009, 0.012, 0.01, 0.011, 0.01, 0.009, 0.011];

const ctx = (over: Partial<EvalContext>): EvalContext => ({ output: 'an answer', ...over });

describe('cost_anomaly — the rule', () => {
  it('is a measurement in the cost bundle that reads only the cost, and it is registered', () => {
    expect(costAnomaly.kind).toBe('measurement');
    expect(costAnomaly.evalType).toBe('cost');
    expect(costAnomaly.needs).toEqual(['cost']);
    expect(costAnomaly.question).toBe('within_budget');
    expect(costRules.map((r) => r.name)).toContain('cost_anomaly');
  });

  it('skips without a cost, and skips as insufficient_history below twenty prior costed traces — saying how many it had', () => {
    const noCost = costAnomaly.evaluate(ctx({}));
    expect(noCost.skipped).toBe(true);
    expect(noCost.skipReason).toContain('costUsd');
    const none = costAnomaly.evaluate(ctx({ costUsd: 0.5 }));
    expect(none.skipped).toBe(true);
    expect(none.skipReason).toBe(`insufficient_history: 0 prior costed traces, ${COST_ANOMALY_MIN_HISTORY} needed`);
    const thin = costAnomaly.evaluate(ctx({ costUsd: 0.5, costHistory: A.slice(0, COST_ANOMALY_MIN_HISTORY - 1) }));
    expect(thin.skipped).toBe(true);
    expect(thin.skipReason).toContain(`${COST_ANOMALY_MIN_HISTORY - 1} prior costed traces`);
  });

  it('fires over the agent\'s own baseline with the modified z as evidence, and passes at the usual cost', () => {
    const fired = costAnomaly.evaluate(ctx({ costUsd: 0.05, costHistory: A }));
    expect(fired.skipped).toBeFalsy();
    expect(fired.passed).toBe(false);
    expect(fired.value).toEqual({ stat: 'cost', unit: 'usd', value: 0.05 });
    const z = fired.evidence!.find((e) => e.type === 'count') as { stat: string; value: number; threshold: number; thresholdSource: string };
    expect(z.stat).toBe('modified_z');
    expect(z.threshold).toBe(COST_ANOMALY_Z);
    expect(z.thresholdSource).toBe('rule');
    expect(z.value).toBeCloseTo((0.6745 * 0.04) / 0.001, 4);
    expect(fired.message).toContain("this agent's own baseline");
    expect(fired.message).not.toMatch(/\$0\.10\b|per-trace threshold/);
    const usual = costAnomaly.evaluate(ctx({ costUsd: 0.012, costHistory: A }));
    expect(usual.passed).toBe(true);
    expect(usual.score).toBe(1);
    expect(usual.message).toContain('usual for this agent');
  });

  it('the same dollar figure is a spike for a cheap agent and routine for a dear one', () => {
    const cheap = Array(30).fill(0).map((_, i) => 0.004 + (i % 3) * 0.0005);
    const dear = Array(30).fill(0).map((_, i) => 0.14 + (i % 3) * 0.01);
    expect(costAnomaly.evaluate(ctx({ costUsd: 0.15, costHistory: cheap })).passed).toBe(false);
    expect(costAnomaly.evaluate(ctx({ costUsd: 0.15, costHistory: dear })).passed).toBe(true);
  });

  it('a flat history uses the approved fallback and the evidence says so', () => {
    const flat = Array(25).fill(0.02);
    const fired = costAnomaly.evaluate(ctx({ costUsd: 0.0225, costHistory: flat }));
    expect(fired.passed).toBe(false);
    const ev = fired.evidence!.find((e) => e.type === 'count') as { stat: string; value: number; threshold: number };
    expect(ev.stat).toBe('cost_over_prior_maximum');
    expect(ev.value).toBeCloseTo(1.125, 6);
    expect(ev.threshold).toBeCloseTo(1.1, 6);
    expect(fired.message).toContain('the fallback line is 10% over every prior value');
    const within = costAnomaly.evaluate(ctx({ costUsd: 0.021, costHistory: flat }));
    expect(within.passed).toBe(true);
    expect(within.message).toContain('within 10% of the most this agent has cost before');
  });

  it('names the dearest call as recorded when the trajectory prices its calls, and the largest estimated share when it does not', () => {
    const priced = costAnomaly.evaluate(
      ctx({
        costUsd: 0.05,
        costHistory: A,
        toolCalls: [
          { tool_name: 'read_file', output: 'x'.repeat(10), cost_usd: 0.001 },
          { tool_name: 'web_search', output: 'y'.repeat(5), cost_usd: 0.04 },
        ],
      }),
    );
    const top = priced.evidence!.find((e) => e.type === 'toolCall') as { index: number; toolName: string; label: string };
    expect(top.index).toBe(1);
    expect(top.toolName).toBe('web_search');
    expect(top.label).toContain('as recorded');
    expect(priced.message).toContain('The dearest call was web_search at $0.0400');
    const unpriced = costAnomaly.evaluate(
      ctx({
        costUsd: 0.05,
        costHistory: A,
        toolCalls: [
          { tool_name: 'read_file', output: 'x'.repeat(30) },
          { tool_name: 'grep', output: 'y'.repeat(10) },
        ],
      }),
    );
    const est = unpriced.evidence!.find((e) => e.type === 'toolCall') as { index: number; toolName: string; label: string };
    expect(est.index).toBe(0);
    expect(est.label).toContain('estimated share');
    expect(unpriced.message).toContain('estimated');
    expect(unpriced.message).toContain('read_file at about $0.0375');
  });
});

describe('the engine feeds the rule the agent\'s own history', () => {
  let storage: SqliteAdapter;
  let engine: ReturnType<typeof createIrisServer>['evalEngine'];

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    engine = createIrisServer(defaultConfig, storage).evalEngine;
  });
  afterEach(async () => {
    await storage.close();
  });

  const trace = (i: number, cost: number, agent = 'bot'): Trace & { output: string } => ({
    trace_id: `t-${String(i).padStart(3, '0')}`,
    agent_name: agent,
    output: 'a fine answer with enough words to pass the length rule and say something true',
    timestamp: new Date(Date.UTC(2026, 8, 1, 0, i, 0)).toISOString(),
    cost_usd: cost,
  });

  it('costHistoryFor reads the agent\'s prior costs newest first, excludes the trace itself and other agents, and is undefined without a cost', async () => {
    for (let i = 0; i < 25; i += 1) {
      const t = trace(i, 0.01 + (i % 4) * 0.0005);
      await storage.insertTrace(LOCAL_TENANT, t);
      await evaluateStoredTrace(engine, storage, LOCAL_TENANT, t, { evalType: 'cost' });
    }
    await storage.insertTrace(LOCAL_TENANT, trace(99, 5, 'other-bot'));
    const subject = trace(30, 0.5);
    await storage.insertTrace(LOCAL_TENANT, subject);
    const history = (await costHistoryFor(storage, LOCAL_TENANT, subject))!;
    expect(history).toHaveLength(25);
    expect(history[0]).toBeCloseTo(0.01, 6); // i = 24 → 24 % 4 = 0
    expect(history.every((c) => c < 0.02)).toBe(true);
    expect(await costHistoryFor(storage, LOCAL_TENANT, { ...subject, cost_usd: undefined })).toBeUndefined();
  });

  it('through the store-and-evaluate primitive, the twenty-sixth trace at fifty times the usual cost fails cost_anomaly and the first twenty-five skip it as insufficient history', async () => {
    let firstSkip: string | undefined;
    for (let i = 0; i < 25; i += 1) {
      const t = trace(i, 0.01 + (i % 4) * 0.0005);
      await storage.insertTrace(LOCAL_TENANT, t);
      const { result } = await evaluateStoredTrace(engine, storage, LOCAL_TENANT, t, { evalType: 'cost' });
      const row = result.rule_results.find((r) => r.ruleName === 'cost_anomaly')!;
      if (i < COST_ANOMALY_MIN_HISTORY) {
        expect(row.skipped, `trace ${i}`).toBe(true);
        firstSkip ??= row.skipReason;
      } else {
        expect(row.skipped, `trace ${i}`).toBeFalsy();
        expect(row.passed, `trace ${i}`).toBe(true);
      }
    }
    expect(firstSkip).toContain('insufficient_history');
    const spike = trace(30, 0.5);
    await storage.insertTrace(LOCAL_TENANT, spike);
    const { result } = await evaluateStoredTrace(engine, storage, LOCAL_TENANT, spike, { evalType: 'cost' });
    const row = result.rule_results.find((r) => r.ruleName === 'cost_anomaly')!;
    expect(row.skipped).toBeFalsy();
    expect(row.passed).toBe(false);
    expect(row.role).toBe('advisory');
    expect(row.uncertainty?.basis).toBe('definition');
    // A measurement never decides: the cost policy at its default advises too, so the evaluation is not failed by this row.
    expect(result.rule_results.filter((r) => r.passed === false && !r.skipped).map((r) => r.ruleName)).toContain('cost_anomaly');
  });
});
