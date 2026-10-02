/*
 * A check somebody asked for, on a call that left out what it reads, is
 * not a pass.
 *
 * A rule that has nothing to judge skips, and a skip is not a finding: a
 * text-only evaluation must not read "unknown" because it has no tool calls.
 * But that reasoning also covered the checks a deployment had asked for by
 * name. With a cost ceiling set to $0.05, a $1.33 run failed, and the same
 * run with the cost field left out passed, clean. The same for a step
 * ceiling with the tool calls left out, for a rule the deployment promoted
 * to critical, and for an expected trajectory sent with nothing to compare
 * it against.
 */
import { describe, expect, it } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { createCustomRule } from '../../../src/eval/rules/custom.js';
import { compose, DEFAULT_COMPOSE } from '../../../src/eval/compose.js';
import type { EvalContext, EvalResult } from '../../../src/types/eval.js';

/** An engine as the server builds it: `thresholds` are the ones the deployment's config file set, recorded as such. */
const engine = (evalConfig: Record<string, unknown> = {}, thresholds: Record<string, unknown> = {}): EvalEngine =>
  new EvalEngine(defaultConfig.eval.defaultThreshold, { ...defaultConfig.eval.ruleThresholds, ...thresholds } as never, {
    ...defaultConfig.eval,
    ...evalConfig,
    configuredThresholdKeys: Object.keys(thresholds),
  } as never);

const ASK = 'Summarise the refund policy for the customer in two sentences.';
const ANSWER = 'Refunds are available within 30 days of purchase for unused items. Opened items can be exchanged but not refunded, and the customer was told so.';
const base: EvalContext = { input: ASK, output: ANSWER };
const calls = Array.from({ length: 6 }, (_, i) => ({ tool_name: 'lookup', input: { page: i }, output: `page ${i}` }));
const rule = (r: EvalResult, name: string) => r.rule_results.find((x) => x.ruleName === name)!;

describe('a policy the deployment set, on a call without what it reads', () => {
  it('a cost ceiling: over it fails, and leaving the cost out is not checked instead of a pass', async () => {
    const e = engine({}, { cost_threshold: 0.05 });
    const over = await e.evaluateAll({ ...base, costUsd: 1.33 });
    expect(over.verdict).toMatchObject({ state: 'fail', basis: 'policy_gate', by: ['cost_under_threshold'] });

    const left = await e.evaluateAll(base);
    expect(rule(left, 'cost_under_threshold')).toMatchObject({ skipped: true, state: 'not_checked', lacked: ['cost'], asked: 'config' });
    expect(left.verdict).toMatchObject({ state: 'unknown', passed: false, basis: 'required_evidence_missing', by: ['cost'] });
    expect(left.passed).toBe(false);
    const said = left.interpretations!.find((i) => i.severity === 'block')!;
    expect(said.addressee).toBe('agent');
    expect(said.text).toBe('Not checked, which is not a pass: cost_under_threshold could not run without cost (this deployment asks for it). Send cost and ask again.');

    // Within the ceiling it passes, so the ceiling is not what blocks: the missing cost is.
    expect((await e.evaluateAll({ ...base, costUsd: 0.01 })).verdict!.state).toBe('pass');
  });

  it('at the shipped ceiling nobody asked, and a call with no cost passes as before', async () => {
    const r = await engine().evaluateAll(base);
    expect(rule(r, 'cost_under_threshold')).toMatchObject({ skipped: true, lacked: ['cost'] });
    expect(rule(r, 'cost_under_threshold').asked).toBeUndefined();
    expect(r.verdict!.state).toBe('pass');
  });

  it('a step ceiling: over it fails, and leaving the tool calls out is not checked', async () => {
    const e = engine({}, { max_steps: 3 });
    expect((await e.evaluateAll({ ...base, toolCalls: calls })).verdict).toMatchObject({ state: 'fail', basis: 'policy_gate', by: ['max_steps'] });
    const left = await e.evaluateAll(base);
    expect(rule(left, 'max_steps')).toMatchObject({ skipped: true, lacked: ['tool_calls'], asked: 'config' });
    expect(left.verdict).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['tool_calls'] });
  });

  it('a relevance threshold the deployment set, on a call with no input', async () => {
    const e = engine({}, { keyword_overlap: 0.4 });
    const left = await e.evaluateAll({ output: ANSWER });
    expect(rule(left, 'answers_the_ask')).toMatchObject({ skipped: true, asked: 'config' });
    expect(rule(left, 'answers_the_ask').lacked).toContain('input');
    expect(left.verdict).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing' });
    expect(left.verdict!.by).toContain('input');
  });
});

describe('a rule the deployment made a gate, on a call without what it reads', () => {
  it('a built-in rule promoted to critical: with the evidence it vetoes, without it the verdict is not checked', async () => {
    const e = engine({ criticalRules: ['no_tool_loop'] });
    const loop = Array.from({ length: 6 }, () => ({ tool_name: 'bash', input: { command: 'ls src/tools' }, output: 'a b c' }));
    expect((await e.evaluateAll({ ...base, toolCalls: loop })).verdict).toMatchObject({ state: 'fail', basis: 'detector_veto', by: ['no_tool_loop'] });
    const left = await e.evaluateAll(base);
    expect(rule(left, 'no_tool_loop')).toMatchObject({ skipped: true, critical: true, lacked: ['tool_calls'], asked: 'config' });
    expect(left.verdict).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['tool_calls'] });
  });

  it('the same rule at its shipped criticality is not asked for, and a text-only call passes', async () => {
    const r = await engine().evaluateAll(base);
    expect(rule(r, 'no_tool_loop')).toMatchObject({ skipped: true, lacked: ['tool_calls'] });
    expect(rule(r, 'no_tool_loop').asked).toBeUndefined();
    expect(r.verdict!.state).toBe('pass');
  });

  it('a deployed rule with a gating severity that reads the cost', async () => {
    const e = engine();
    e.registerRule('cost', createCustomRule({ name: 'under-a-cent', type: 'cost_threshold', config: { max_cost: 0.01 } }, 'high'), 'rule-1');
    expect((await e.evaluateAll({ ...base, costUsd: 0.5 })).verdict!.state).toBe('fail');
    const left = await e.evaluateAll(base);
    const r = rule(left, 'under-a-cent');
    if (r.skipped) {
      expect(r).toMatchObject({ asked: 'config', lacked: ['cost'] });
      expect(left.verdict).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['cost'] });
    } else {
      // A custom cost rule that judges a missing cost as a failure already does not pass.
      expect(left.verdict!.state).not.toBe('pass');
    }
  });
});

describe('an expectation the call supplied, with nothing to compare it against', () => {
  it('an expected trajectory and no tool calls is not checked; with the calls it is judged', async () => {
    const expectedTrajectory = { tool_calls: [{ tool_name: 'lookup' }] };
    const left = await engine().evaluateAll({ ...base, expectedTrajectory } as EvalContext);
    expect(rule(left, 'tool_sequence')).toMatchObject({ skipped: true, lacked: ['tool_calls'], asked: 'call' });
    expect(left.verdict).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['tool_calls'] });
    expect(left.interpretations!.find((i) => i.severity === 'block')!.text).toContain('tool_sequence could not run without tool_calls (this call asks for it)');

    const sent = await engine().evaluateAll({ ...base, expectedTrajectory, toolCalls: calls.slice(0, 1) } as EvalContext);
    expect(rule(sent, 'tool_sequence').skipped).toBeFalsy();
    expect(sent.verdict!.basis).not.toBe('required_evidence_missing');
  });
});

describe('how it sits with the other layers', () => {
  it('a failure is still a failure: the missing evidence is listed after it, never instead of it', async () => {
    const r = await engine({}, { cost_threshold: 0.05 }).evaluateAll({ input: ASK, output: 'The reporter is Marisol Quintero, SSN 123-45-6789, and her card was charged twice.' });
    expect(r.verdict).toMatchObject({ state: 'fail', basis: 'detector_veto' });
    expect(r.verdict!.also).toContainEqual({ basis: 'required_evidence_missing', state: 'unknown', by: ['cost'] });
  });

  it('a stored row composes to the same verdict on read: the stamps are in the rule results', async () => {
    const r = await engine({}, { cost_threshold: 0.05 }).evaluateAll(base);
    const stored = JSON.parse(JSON.stringify({ rule_results: r.rule_results, score: r.score, insufficient_data: r.insufficient_data, rules_evaluated: r.rules_evaluated })) as EvalResult;
    expect(compose(stored, DEFAULT_COMPOSE)).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['cost'] });
    // A row stored before the stamps existed carries none, and reads as it did.
    for (const row of stored.rule_results) {
      delete row.asked;
      delete row.lacked;
    }
    expect(compose(stored, DEFAULT_COMPOSE).state).toBe('pass');
  });

  it('no labelled case changes: nothing in the corpus configures a policy and then leaves its evidence out', async () => {
    const { loadComposite, compositeContext } = await import('../../../proof/lib/composite.js');
    const loaded = await loadComposite(process.cwd());
    const e = engine();
    for (const c of loaded.cases) {
      const r = await e.evaluateAll(compositeContext(loaded, c));
      const asked = r.rule_results.filter((x) => x.asked !== undefined).map((x) => `${x.ruleName}:${x.asked}`);
      // Only a call that supplied an expected trajectory can ask at the shipped configuration.
      expect(asked.filter((a) => !a.endsWith(':call')), c.id).toEqual([]);
      if (asked.length === 0) expect(r.verdict!.basis, c.id).not.toBe('required_evidence_missing');
    }
  }, 120_000);
});
