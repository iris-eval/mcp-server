/*
 * The layers after the one that decided.
 *
 * `Verdict.basis` names the first layer with something to say, and the
 * layers do not exclude each other: one output can break a policy the
 * deployment set and leak a credential. Everything that acted on a single
 * basis read `basis` alone, so the leak went unseen wherever a policy
 * failed first:
 *
 *   - `iris-eval ingest --fail-on detector_veto` (the gate action's
 *     default) exited 0 on it;
 *   - the `detector_veto` webhook did not fire;
 *   - the agent was told its cost ceiling failed, and nothing else.
 *
 * `Verdict.also` lists every later layer that would have decided on its
 * own, and each of the three reads it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { compose, interpretations, verdictPath, DEFAULT_COMPOSE, type ComposeConfig } from '../../../src/eval/compose.js';
import { trippedLayers, trips, FAIL_ON } from '../../../src/cli/ingest.js';
import { momentsOf } from '../../../src/notify/events.js';
import { WEBHOOK_EVENTS, type WebhookEventName } from '../../../src/notify/event-names.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import { verdictSchema } from '../../../src/eval/response-schema.js';
import type { EvalResult, EvalRuleResult, Verdict } from '../../../src/types/eval.js';

const cfg = (over: Partial<ComposeConfig> = {}): ComposeConfig => ({ ...DEFAULT_COMPOSE, ...over });
const row = (over: Partial<EvalRuleResult> & { ruleName: string }): EvalRuleResult => ({ passed: true, score: 1, message: '', ...over }) as EvalRuleResult;
const result = (rows: EvalRuleResult[]): EvalResult =>
  ({
    id: 'e1',
    eval_type: 'all',
    output_text: 'x',
    score: 1,
    passed: true,
    rule_results: rows,
    rules_evaluated: rows.filter((r) => !r.skipped).length,
    rules_skipped: rows.filter((r) => r.skipped).length,
    insufficient_data: false,
  }) as EvalResult;

// A policy the deployment set, a critical detector with no published rate (so no risk term), and one that has a rate.
const GATE = row({ ruleName: 'cost_under_threshold', kind: 'policy', passed: false, evidence: [{ type: 'count', stat: 'cost', unit: 'usd', value: 5, threshold: 1, thresholdSource: 'config' }] });
const VETO = row({ ruleName: 'my_detector', kind: 'detection', critical: true, passed: false });
const PII = row({ ruleName: 'no_pii', kind: 'detection', critical: true, passed: false, classes: ['pii_leak'] });
const COULD_NOT_ANSWER = row({ ruleName: 'no_injection_patterns', kind: 'detection', critical: true, skipped: true, skipClass: 'defeated', passed: false });
const RISKY = row({ ruleName: 'no_silent_tool_failure', kind: 'inference', passed: false, classes: ['silent_tool_failure'] });

describe('compose — a later layer that would have decided is on the verdict', () => {
  it('a policy gate and a critical detector: the gate is the basis, the veto is in also', () => {
    const v = compose(result([GATE, VETO]), cfg());
    expect(v).toMatchObject({ state: 'fail', passed: false, basis: 'policy_gate', by: ['cost_under_threshold'], risk: null });
    expect(v.also).toEqual([{ basis: 'detector_veto', state: 'fail', by: ['my_detector'] }]);
  });

  it('one layer alone carries no also key at all, and neither does a pass', () => {
    expect(compose(result([GATE]), cfg())).not.toHaveProperty('also');
    expect(compose(result([VETO]), cfg())).not.toHaveProperty('also');
    expect(compose(result([row({ ruleName: 'fine', kind: 'measurement' })]), cfg())).not.toHaveProperty('also');
  });

  it('lists every later layer in the order the layers are asked', () => {
    const v = compose(result([GATE, PII, COULD_NOT_ANSWER, row({ ruleName: 'fine', kind: 'measurement', saw: ['output'] })]), cfg({ requiredEvidence: ['tool_calls'] }));
    expect(v.basis).toBe('policy_gate');
    expect(v.also!.map((l) => l.basis)).toEqual(['detector_veto', 'critical_unknown', 'required_evidence_missing', 'risk_over_loss']);
    expect(v.also![0]).toEqual({ basis: 'detector_veto', state: 'fail', by: ['no_pii'] });
    expect(v.also![1]).toEqual({ basis: 'critical_unknown', state: 'unknown', by: ['no_injection_patterns'] });
    expect(v.also![2]).toEqual({ basis: 'required_evidence_missing', state: 'unknown', by: ['tool_calls'] });
    expect(v.also![3]).toMatchObject({ basis: 'risk_over_loss', state: 'fail' });
  });

  it('a critical check that could not answer follows eval.onCriticalSkipped in also as it does when it decides', () => {
    const rows = [VETO, COULD_NOT_ANSWER];
    expect(compose(result(rows), cfg()).also).toEqual([{ basis: 'critical_unknown', state: 'unknown', by: ['no_injection_patterns'] }]);
    expect(compose(result(rows), cfg({ onCriticalSkipped: 'fail' })).also).toEqual([{ basis: 'critical_unknown', state: 'fail', by: ['no_injection_patterns'] }]);
    // The deployment accepted that risk: the layer does not decide, first or later.
    expect(compose(result(rows), cfg({ onCriticalSkipped: 'pass' }))).not.toHaveProperty('also');
  });

  it('a failure outranks a check that could not run: the risk layer fails the verdict, and the unknown layer is listed beside it', () => {
    // This read `unknown` with the risk layer in `also`: a second problem softened the first.
    const v = compose(result([COULD_NOT_ANSWER, RISKY]), cfg());
    expect(v).toMatchObject({ state: 'fail', passed: false, basis: 'risk_over_loss', by: ['silent_tool_failure'] });
    expect(v.risk).not.toBeNull();
    expect(v.also).toEqual([{ basis: 'critical_unknown', state: 'unknown', by: [COULD_NOT_ANSWER.ruleName] }]);
    // The path runs through the layer that could not check to the one that fails.
    const path = verdictPath(result([COULD_NOT_ANSWER, RISKY]), cfg());
    expect(path.map((n) => [n.node, n.decided])).toEqual([['gate', false], ['veto', false], ['unknown', true], ['risk', true]]);
    // With nothing to fail it, the check that could not run still makes the verdict unknown.
    expect(compose(result([COULD_NOT_ANSWER, row({ ruleName: 'quiet_rule' })]), cfg())).toMatchObject({ state: 'unknown', basis: 'critical_unknown' });
    // The same rows with nothing unknown: the risk layer decides, and carries the estimate.
    const alone = compose(result([RISKY]), cfg());
    expect(alone).toMatchObject({ state: 'fail', basis: 'risk_over_loss', by: ['silent_tool_failure'] });
    expect(alone.risk).not.toBeNull();
    expect(alone).not.toHaveProperty('also');
  });

  it('a failing judgment is a gate, critical or not, and is not counted a second time as a veto', () => {
    const v = compose(result([row({ ruleName: 'judge_accuracy', kind: 'judgment', critical: true, passed: false })]), cfg());
    expect(v).toMatchObject({ basis: 'policy_gate', by: ['judge_accuracy'] });
    expect(v).not.toHaveProperty('also');
  });

  it('the path still ends at the layer that decided', () => {
    const path = verdictPath(result([GATE, VETO]), cfg());
    expect(path).toEqual([{ node: 'gate', by: ['cost_under_threshold'], decided: true }]);
  });

  it('the published response schema accepts a verdict with also', () => {
    const v = compose(result([GATE, VETO]), cfg());
    expect(verdictSchema.safeParse(v).success).toBe(true);
  });
});

describe('interpretations — the agent is told about every layer, not only the first', () => {
  it('names the later layer and says clearing the first does not clear the verdict', () => {
    const r = result([GATE, PII]);
    const v = compose(r, cfg());
    const block = interpretations(r, v, cfg()).filter((n) => n.severity === 'block');
    expect(block).toHaveLength(1);
    expect(block[0].addressee).toBe('agent');
    expect(block[0].text).toContain('policy_gate decided this verdict');
    expect(block[0].text).toContain('a critical rule fired (no_pii)');
    expect(block[0].text).toContain('Clearing cost_under_threshold alone does not clear the verdict');
    // The risk layer after a veto is the same detector read again: no clause for it.
    expect(block[0].text).not.toContain('risk of a bad output');
  });

  it('a veto with only the risk layer behind it gets no extra sentence', () => {
    const r = result([PII]);
    const v = compose(r, cfg());
    expect(v.also?.map((l) => l.basis)).toEqual(['risk_over_loss']);
    expect(interpretations(r, v, cfg()).filter((n) => n.severity === 'block')).toEqual([]);
  });

  it('a gate with only the risk layer behind it does: that is a second finding', () => {
    const r = result([GATE, RISKY]);
    const v = compose(r, cfg());
    const block = interpretations(r, v, cfg()).filter((n) => n.severity === 'block');
    expect(block).toHaveLength(1);
    expect(block[0].text).toContain('risk of a bad output over the loss threshold (silent_tool_failure)');
  });
});

describe('--fail-on reads every layer', () => {
  const masked = compose(result([GATE, VETO]), cfg());
  const unknownThenRisk = compose(result([COULD_NOT_ANSWER, RISKY]), cfg());
  const clean = compose(result([row({ ruleName: 'fine', kind: 'measurement' })]), cfg());

  it('a basis trips when that layer decided or would have', () => {
    expect(trips('policy_gate', masked)).toBe(true);
    expect(trips('detector_veto', masked)).toBe(true);
    expect(trips('critical_unknown', masked)).toBe(false);
    expect(trips('risk_over_loss', unknownThenRisk)).toBe(true);
    expect(trips('critical_unknown', unknownThenRisk)).toBe(true);
  });

  it('fail and unknown read the state of each layer', () => {
    expect(trips('fail', unknownThenRisk), 'unknown by basis, and failing by risk').toBe(true);
    expect(trips('unknown', unknownThenRisk)).toBe(true);
    expect(trips('unknown', masked)).toBe(false);
    expect(trips('fail', masked)).toBe(true);
  });

  it('a pass trips nothing, on any value', () => {
    for (const f of FAIL_ON) expect(trips(f, clean), f).toBe(false);
  });

  it('the tripping layers carry the rules whose spans the receipt prints', () => {
    expect(trippedLayers('detector_veto', masked).flatMap((l) => l.by ?? [])).toEqual(['my_detector']);
    expect(trippedLayers('any', masked).flatMap((l) => l.by ?? [])).toEqual(['cost_under_threshold', 'my_detector']);
  });
});

describe('the detector_veto webhook reads every layer', () => {
  const ALL = new Set<WebhookEventName>(WEBHOOK_EVENTS);
  const stores: SqliteAdapter[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.close();
  });
  async function moments(verdict: Verdict, rows: EvalRuleResult[]) {
    const s = new SqliteAdapter(':memory:');
    await s.initialize();
    stores.push(s);
    await s.insertTrace(LOCAL_TENANT, { trace_id: 't-1', agent_name: 'support-bot', input: 'ask', output: 'answer', timestamp: '2026-09-21T12:00:00.000Z' });
    const stored = { ...result(rows), trace_id: 't-1', passed: false, verdict, critical_failures: ['my_detector'], created_at: '2026-09-21T12:00:01.000Z' } as EvalResult;
    return momentsOf(s, LOCAL_TENANT, stored, ALL);
  }

  it('fires for a veto an earlier gate decided ahead of, and names the detector, not the policy', async () => {
    const out = await moments(compose(result([GATE, VETO]), cfg()), [GATE, VETO]);
    expect(out.map((m) => m.event)).toEqual(['verdict_fail', 'detector_veto']);
    const veto = out[1];
    expect(veto.subject).toBe('my_detector');
    expect(veto.summary).toBe('support-bot: a critical detection vetoed the verdict — my_detector.');
    expect(veto.detail).toMatchObject({ by: ['my_detector'] });
    expect(veto.verdict).toMatchObject({ basis: 'policy_gate', also: [{ basis: 'detector_veto', state: 'fail', by: ['my_detector'] }] });
  });

  it('a policy failure with no veto beside it is verdict_fail only', async () => {
    const out = await moments(compose(result([GATE]), cfg()), [GATE]);
    expect(out.map((m) => m.event)).toEqual(['verdict_fail']);
    expect(out[0].verdict).not.toHaveProperty('also');
  });

  it('an unknown verdict a later layer would have failed is a failed verdict', async () => {
    const out = await moments(compose(result([COULD_NOT_ANSWER, RISKY]), cfg()), [COULD_NOT_ANSWER, RISKY]);
    expect(out.map((m) => m.event)).toEqual(['verdict_fail']);
  });
});
