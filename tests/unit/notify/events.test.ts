/*
 * What a stored evaluation says (arc 9, N-16): the five moments read from
 * the store after the row is written — a failed verdict, a veto, the cost
 * anomaly rule, the CUSUM alarm at the evaluation that crossed the line,
 * and the first attempt that disagreed with every earlier one.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import type { EvalResult, EvalRuleResult, Verdict } from '../../../src/types/eval.js';
import { momentsOf } from '../../../src/notify/events.js';
import { WEBHOOK_EVENTS, type WebhookEventName } from '../../../src/notify/event-names.js';
import { regressionAlarms } from '../../../src/eval/cusum.js';

const ALL = new Set<WebhookEventName>(WEBHOOK_EVENTS);
const stores: SqliteAdapter[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function store(): Promise<SqliteAdapter> {
  const s = new SqliteAdapter(':memory:');
  await s.initialize();
  stores.push(s);
  return s;
}

const rule = (ruleName: string, passed: boolean, extra: Partial<EvalRuleResult> = {}): EvalRuleResult =>
  ({ ruleName, passed, score: passed ? 1 : 0, message: `${ruleName} ${passed ? 'passed' : 'failed'}`, ...extra }) as EvalRuleResult;

const verdict = (state: Verdict['state'], basis: Verdict['basis'], by: string[]): Verdict => ({ state, passed: state === 'pass', basis, by, risk: null });

let seq = 0;
async function stored(s: SqliteAdapter, traceOver: Record<string, unknown>, evalOver: Partial<EvalResult>): Promise<EvalResult> {
  seq += 1;
  const traceId = (traceOver.trace_id as string | undefined) ?? `t-${seq}`;
  await s.insertTrace(LOCAL_TENANT, { trace_id: traceId, agent_name: 'support-bot', input: `ask ${seq}`, output: 'answer', timestamp: `2026-09-21T12:${String(seq % 60).padStart(2, '0')}:00.000Z`, ...traceOver });
  const result: EvalResult = {
    id: `e-${seq}`,
    trace_id: traceId,
    eval_type: 'all',
    output_text: 'answer',
    score: 1,
    passed: true,
    rule_results: [rule('no_pii', true)],
    verdict: verdict('pass', 'clean', []),
    created_at: `2026-09-21T12:${String(seq % 60).padStart(2, '0')}:01.000Z`,
    ...evalOver,
  };
  await s.insertEvalResult(LOCAL_TENANT, result);
  return result;
}

describe('momentsOf', () => {
  it('a passing evaluation is no moment; nothing wanted is nothing read', async () => {
    const s = await store();
    const ok = await stored(s, {}, {});
    expect(await momentsOf(s, LOCAL_TENANT, ok, ALL)).toEqual([]);
    const bad = await stored(s, {}, { passed: false, score: 0.2, verdict: verdict('fail', 'policy_gate', ['min_output_length']) });
    expect(await momentsOf(s, LOCAL_TENANT, bad, new Set())).toEqual([]);
  });

  it('a failed verdict is verdict_fail with its basis; a veto is also detector_veto; both carry ids, the rules and never the text', async () => {
    const s = await store();
    const vetoed = await stored(
      s,
      { run_id: 'nightly-1', case_key: 'refund', session_id: 'sess-1' },
      { passed: false, score: 0.3, rule_results: [rule('no_pii', false), rule('min_output_length', true)], critical_failures: ['no_pii'], verdict: verdict('fail', 'detector_veto', ['no_pii']) },
    );
    const moments = await momentsOf(s, LOCAL_TENANT, vetoed, ALL);
    expect(moments.map((m) => m.event)).toEqual(['verdict_fail', 'detector_veto']);
    const [fail, veto] = moments;
    expect(fail).toMatchObject({ subject: 'no_pii', evaluation_id: vetoed.id, trace_id: vetoed.trace_id, agent_name: 'support-bot', run_id: 'nightly-1', case_key: 'refund', session_id: 'sess-1', failed_rules: ['no_pii'], critical_failures: ['no_pii'], score: 0.3 });
    expect(fail.summary).toBe('support-bot: the verdict failed on detector veto — no_pii.');
    expect(veto.summary).toBe('support-bot: a critical detection vetoed the verdict — no_pii.');
    expect(veto.detail).toEqual({ by: ['no_pii'], critical_failures: ['no_pii'] });
    for (const m of moments) {
      expect(JSON.stringify(m)).not.toContain('answer');
      expect(JSON.stringify(m)).not.toContain('ask ');
    }
    // A gate is verdict_fail alone.
    const gated = await stored(s, {}, { passed: false, verdict: verdict('fail', 'policy_gate', ['min_output_length']) });
    expect((await momentsOf(s, LOCAL_TENANT, gated, ALL)).map((m) => m.event)).toEqual(['verdict_fail']);
    // Only what is wanted.
    expect((await momentsOf(s, LOCAL_TENANT, vetoed, new Set<WebhookEventName>(['detector_veto']))).map((m) => m.event)).toEqual(['detector_veto']);
  });

  it('an evaluation stored without a verdict reads its passed flag', async () => {
    const s = await store();
    const legacy = await stored(s, {}, { passed: false, verdict: undefined });
    const [m] = await momentsOf(s, LOCAL_TENANT, legacy, ALL);
    expect(m).toMatchObject({ event: 'verdict_fail', verdict: null, subject: 'verdict', session_id: null });
  });

  it('the cost_anomaly rule firing is cost_anomaly with the cost, the modified z and the threshold', async () => {
    const s = await store();
    const spike = await stored(
      s,
      { cost_usd: 1.33 },
      {
        rule_results: [
          rule('cost_anomaly', false, {
            message: 'This trace cost $1.33 against a median of $0.02.',
            value: { stat: 'cost', unit: 'usd', value: 1.33 },
            evidence: [{ type: 'count', stat: 'modified_z', unit: 'z', value: 44.1, threshold: 3.5, thresholdSource: 'rule' }],
          } as Partial<EvalRuleResult>),
        ],
        verdict: verdict('pass', 'clean', []),
      },
    );
    const moments = await momentsOf(s, LOCAL_TENANT, spike, ALL);
    expect(moments.map((m) => m.event)).toEqual(['cost_anomaly']);
    expect(moments[0]).toMatchObject({ subject: 'cost_anomaly', summary: 'This trace cost $1.33 against a median of $0.02.', detail: { cost_usd: 1.33, modified_z: 44.1, threshold: 3.5 } });
    // A skipped cost rule is not a moment.
    const skipped = await stored(s, {}, { rule_results: [rule('cost_anomaly', false, { skipped: true } as Partial<EvalRuleResult>)] });
    expect(await momentsOf(s, LOCAL_TENANT, skipped, ALL)).toEqual([]);
  });

  it('flaky_case fires once, at the first attempt that disagrees with every earlier one', async () => {
    const s = await store();
    const first = await stored(s, { case_key: 'refund', run_id: 'r1' }, {});
    expect(await momentsOf(s, LOCAL_TENANT, first, ALL)).toEqual([]);
    const second = await stored(s, { case_key: 'refund', run_id: 'r2' }, { passed: false, verdict: verdict('fail', 'policy_gate', ['min_output_length']) });
    const moments = await momentsOf(s, LOCAL_TENANT, second, ALL);
    expect(moments.map((m) => m.event)).toEqual(['verdict_fail', 'flaky_case']);
    const flaky = moments[1];
    expect(flaky).toMatchObject({ subject: 'refund', case_key: 'refund', detail: { case_key: 'refund', attempts: 2, passed: 1, runs: ['r1', 'r2'], this_attempt_passed: false } });
    expect(flaky.summary).toBe('support-bot: case refund was answered both ways for the first time — 1 of 2 attempts passed across r1, r2.');
    // Already flaky: a third attempt, either way, is not a new moment.
    const third = await stored(s, { case_key: 'refund', run_id: 'r3' }, {});
    expect((await momentsOf(s, LOCAL_TENANT, third, ALL)).map((m) => m.event)).toEqual([]);
    const fourth = await stored(s, { case_key: 'refund', run_id: 'r3' }, { passed: false, verdict: verdict('fail', 'policy_gate', ['x']) });
    expect((await momentsOf(s, LOCAL_TENANT, fourth, ALL)).map((m) => m.event)).toEqual(['verdict_fail']);
    // A case that has only ever failed, failing again, is not flaky.
    const fa = await stored(s, { case_key: 'vat' }, { passed: false, verdict: verdict('fail', 'policy_gate', ['x']) });
    const fb = await stored(s, { case_key: 'vat' }, { passed: false, verdict: verdict('fail', 'policy_gate', ['x']) });
    expect((await momentsOf(s, LOCAL_TENANT, fa, ALL)).map((m) => m.event)).toEqual(['verdict_fail']);
    expect((await momentsOf(s, LOCAL_TENANT, fb, ALL)).map((m) => m.event)).toEqual(['verdict_fail']);
    // The first pass after two fails is the transition.
    const fc = await stored(s, { case_key: 'vat' }, {});
    expect((await momentsOf(s, LOCAL_TENANT, fc, ALL)).map((m) => m.event)).toEqual(['flaky_case']);
  });

  it('regression_alarm is raised at the evaluation whose CUSUM crossed the line, for that rule, with the watcher’s sentence', async () => {
    const s = await store();
    // A settled baseline — no_pii failing one call in five — then every call failing.
    const results: EvalResult[] = [];
    for (let i = 0; i < 110; i += 1) {
      const failed = i < 70 ? i % 5 === 0 : true;
      const stamp = new Date(Date.UTC(2026, 8, 1, 0, i, 0)).toISOString();
      results.push(
        await stored(
          s,
          { trace_id: `a-${i}`, timestamp: stamp },
          { id: `ea-${i}`, created_at: stamp, passed: !failed, rule_results: [rule('no_pii', !failed), rule('min_output_length', true)], verdict: failed ? verdict('fail', 'detector_veto', ['no_pii']) : verdict('pass', 'clean', []) },
        ),
      );
    }
    const log = await s.getAgentFailureLog(LOCAL_TENANT, 'support-bot');
    const alarms = regressionAlarms(log);
    expect(alarms.length).toBeGreaterThan(0);
    const alarm = alarms[0];
    const at = results.find((r) => r.trace_id === alarm.traceId)!;
    const moments = await momentsOf(s, LOCAL_TENANT, at, new Set<WebhookEventName>(['regression_alarm']));
    expect(moments).toHaveLength(1);
    expect(moments[0]).toMatchObject({ event: 'regression_alarm', subject: 'no_pii', trace_id: alarm.traceId, detail: { rule: 'no_pii', run: null, monitoredFails: alarm.monitoredFails } });
    expect(moments[0].summary).toMatch(/^The fail rate of no_pii for support-bot has shifted:/);
    // The evaluation before the alarm carries none.
    const before = results[Number(alarm.traceId.slice(2)) - 1];
    expect(await momentsOf(s, LOCAL_TENANT, before, new Set<WebhookEventName>(['regression_alarm']))).toEqual([]);
  }, 60_000);
});
