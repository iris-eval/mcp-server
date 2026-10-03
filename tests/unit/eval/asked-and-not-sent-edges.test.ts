/*
 * The edges of "asked for, and not sent" (see asked-and-not-sent.test.ts
 * for the rule itself). Each case here read wrongly before 0.20.0 shipped,
 * and was found by a review that set out to break it:
 *
 *   - an honest turn that used no tool read "not checked" under a step
 *     ceiling, with a remedy ("send tool_calls") nobody could follow;
 *   - a blank in place of a field passed where the deleted field did not;
 *   - a threshold on a rule that is not a policy, and an installed judge,
 *     were not counted as asking;
 *   - the sentence blamed the deployment for what the call had asked;
 *   - an expectation of calls against an explicit empty list passed.
 */
import { describe, expect, it } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import type { EvalContext, EvalResult } from '../../../src/types/eval.js';
import type { RelevanceJudge } from '../../../src/eval/llm-judge/relevance-judge.js';

const engine = (evalConfig: Record<string, unknown> = {}, thresholds: Record<string, unknown> = {}): EvalEngine =>
  new EvalEngine(defaultConfig.eval.defaultThreshold, { ...defaultConfig.eval.ruleThresholds, ...thresholds } as never, {
    ...defaultConfig.eval,
    ...evalConfig,
    configuredThresholdKeys: Object.keys(thresholds),
  } as never);

const ASK = 'Summarise the refund policy for the customer in two sentences.';
const ANSWER = 'Refunds are available within 30 days of purchase for unused items. Opened items can be exchanged but not refunded, and the customer was told so.';
const base: EvalContext = { input: ASK, output: ANSWER };
const rule = (r: EvalResult, name: string) => r.rule_results.find((x) => x.ruleName === name)!;
const block = (r: EvalResult): string | undefined => r.interpretations?.find((i) => i.severity === 'block' && i.addressee === 'agent')?.text;

describe('an explicit empty list of tool calls is the caller saying none were made', () => {
  it('under a step ceiling: an honest turn that used no tool passes; the calls left out altogether is not checked', async () => {
    const e = engine({}, { max_steps: 30 });
    const none = await e.evaluateAll({ ...base, toolCalls: [], costUsd: 0.01 });
    expect(rule(none, 'max_steps')).toMatchObject({ skipped: true, state: 'not_checked' });
    expect(rule(none, 'max_steps').lacked).toBeUndefined();
    expect(rule(none, 'max_steps').asked).toBeUndefined();
    expect(none.verdict!.state).toBe('pass');

    const omitted = await e.evaluateAll({ ...base, costUsd: 0.01 });
    expect(rule(omitted, 'max_steps')).toMatchObject({ lacked: ['tool_calls'], asked: 'config' });
    expect(omitted.verdict).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['tool_calls'] });
  });

  it('the same for a rule promoted to critical and for a deployed action policy', async () => {
    const promoted = engine({ criticalRules: ['no_silent_tool_failure'] });
    expect((await promoted.evaluateAll({ ...base, toolCalls: [] })).verdict!.state).toBe('pass');
    expect((await promoted.evaluateAll(base)).verdict).toMatchObject({ state: 'unknown', by: ['tool_calls'] });
  });

  it('a deployment that requires tool calls on every evaluation still refuses an empty list', async () => {
    const e = engine({ requiredEvidence: ['tool_calls'] });
    expect((await e.evaluateAll({ ...base, toolCalls: [] })).verdict).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['tool_calls'] });
  });

  it('against an expectation of calls it is judged, and fails: the expected call never came', async () => {
    const expectedTrajectory = { tool_calls: [{ tool_name: 'search' }] };
    const r = await engine().evaluateAll({ ...base, toolCalls: [], expectedTrajectory } as EvalContext);
    expect(rule(r, 'tool_sequence')).toMatchObject({ state: 'fail', ruleVersion: 2 });
    expect(rule(r, 'tool_sequence').message).toContain('expected call 1 of 1, search, never came');
    expect(r.verdict).toMatchObject({ state: 'fail', basis: 'policy_gate', by: ['tool_sequence'] });
    // A step budget is met by zero calls.
    const budget = await engine().evaluateAll({ ...base, toolCalls: [], expectedTrajectory: { step_budget: 5 } } as EvalContext);
    expect(rule(budget, 'step_budget')).toMatchObject({ state: 'pass', ruleVersion: 2 });
    expect(budget.verdict!.state).toBe('pass');
  });
});

describe('a blank is not a value', () => {
  it('one space in place of the input reads as the input left out', async () => {
    const e = engine({}, { keyword_overlap: 0.4 });
    const blank = await e.evaluateAll({ input: ' ', output: ANSWER });
    const omitted = await e.evaluateAll({ output: ANSWER });
    for (const r of [blank, omitted]) {
      expect(rule(r, 'answers_the_ask')).toMatchObject({ skipped: true, asked: 'config' });
      expect(r.verdict).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing' });
      expect(r.verdict!.by).toContain('input');
    }
    expect((await engine({ requiredEvidence: ['input'] }).evaluateAll({ input: ' \n\t', output: ANSWER })).verdict).toMatchObject({ state: 'unknown', by: ['input'] });
  });

  it('a negative cost reads as the cost left out; zero is a cost', async () => {
    const e = engine({}, { cost_threshold: 0.05 });
    const negative = await e.evaluateAll({ ...base, costUsd: -1 });
    expect(rule(negative, 'cost_under_threshold')).toMatchObject({ skipped: true, lacked: ['cost'], asked: 'config' });
    expect(negative.verdict).toMatchObject({ state: 'unknown', by: ['cost'] });
    expect((await e.evaluateAll({ ...base, costUsd: 0 })).verdict!.state).toBe('pass');
  });

  it('tool outputs that are all blank do not satisfy a requirement for tool outputs', async () => {
    const e = engine({ requiredEvidence: ['tool_outputs'] });
    const call = (output: unknown) => ({ tool_name: 'lookup', input: { page: 1 }, output });
    for (const output of ['', '   ', null, undefined]) {
      const r = await e.evaluateAll({ ...base, toolCalls: [call(output)] } as EvalContext);
      expect(r.verdict, JSON.stringify(output)).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['tool_outputs'] });
    }
    expect((await e.evaluateAll({ ...base, toolCalls: [call('page 1')] } as EvalContext)).verdict!.basis).not.toBe('required_evidence_missing');
  });
});

describe('who counts as having asked', () => {
  it('a threshold on a rule that is not a policy: a repeat ceiling, with the calls left out', async () => {
    const e = engine({}, { max_tool_repeats: 2 });
    const loop = Array.from({ length: 4 }, () => ({ tool_name: 'bash', input: { command: 'ls src' }, output: 'a b' }));
    expect((await e.evaluateAll({ ...base, toolCalls: loop })).verdict!.state).toBe('fail');
    const omitted = await e.evaluateAll(base);
    expect(rule(omitted, 'no_tool_loop')).toMatchObject({ lacked: ['tool_calls'], asked: 'config' });
    expect(omitted.verdict).toMatchObject({ state: 'unknown', by: ['tool_calls'] });
  });

  it('an installed relevance judge, with the input left out', async () => {
    const e = engine();
    const judge = { judge: async () => undefined, describe: () => ({ model: 'm', provider: 'p' }) } as unknown as RelevanceJudge;
    e.setRelevanceJudge(judge);
    const omitted = await e.evaluateAll({ output: ANSWER });
    expect(rule(omitted, 'answers_the_ask')).toMatchObject({ skipped: true, asked: 'config' });
    expect(omitted.verdict).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing' });
    // Without a judge the same call passes: nobody asked.
    expect((await engine().evaluateAll({ output: ANSWER })).verdict!.state).toBe('pass');
  });

  it('eval.onCriticalSkipped: "pass" accepts a promoted rule that could not run for missing evidence', async () => {
    const strict = engine({ criticalRules: ['no_tool_loop'] });
    const accepting = engine({ criticalRules: ['no_tool_loop'], onCriticalSkipped: 'pass' });
    expect((await strict.evaluateAll(base)).verdict!.state).toBe('unknown');
    expect((await accepting.evaluateAll(base)).verdict!.state).toBe('pass');
    // It accepts critical checks only: a cost ceiling the deployment set is still asked for.
    const both = engine({ onCriticalSkipped: 'pass' }, { cost_threshold: 0.05 });
    expect((await both.evaluateAll(base)).verdict).toMatchObject({ state: 'unknown', by: ['cost'] });
  });

  it('the sentence says who asked: the deployment, or the call', async () => {
    const config = await engine({}, { cost_threshold: 0.05 }).evaluateAll(base);
    expect(block(config)).toBe('Not checked, which is not a pass: cost_under_threshold could not run without cost (this deployment asks for it). Send cost and ask again.');

    // The same threshold set on the call itself.
    const call = await engine().evaluateAll({ ...base, customConfig: { cost_threshold: 0.05 } });
    expect(rule(call, 'cost_under_threshold')).toMatchObject({ asked: 'call', lacked: ['cost'] });
    expect(block(call)).toBe('Not checked, which is not a pass: cost_under_threshold could not run without cost (this call asks for it). Send cost and ask again.');

    // A gating rule supplied inline by the call.
    const inline = await engine().evaluateAll(base, [{ name: 'cap', type: 'cost_threshold', config: { max_cost: 0.01 }, severity: 'high' } as never]);
    const cap = rule(inline, 'cap');
    if (cap.skipped) expect(cap).toMatchObject({ asked: 'call', lacked: ['cost'] });
  });

  it('an expectation the call did not make is not asked for: a step budget is no expectation of a sequence', async () => {
    const r = await engine().evaluateAll({ ...base, expectedTrajectory: { step_budget: 5 } } as EvalContext);
    expect(rule(r, 'tool_sequence').asked).toBeUndefined();
    expect(rule(r, 'step_budget')).toMatchObject({ asked: 'call', lacked: ['tool_calls'] });
    expect(block(r)).toBe('Not checked, which is not a pass: step_budget could not run without tool_calls (this call asks for it). Send tool_calls and ask again.');
    // And an empty expectation asks for nothing.
    expect((await engine().evaluateAll({ ...base, expectedTrajectory: {} } as EvalContext)).verdict!.state).toBe('pass');
  });
});

describe('the sentences on a verdict that failed and also could not check something', () => {
  const failing: EvalContext = {
    input: 'Fix the failing date parser and run the test suite.',
    output: 'I fixed the date parser so it accepts ISO week dates, and ran the test suite. All tests pass and the change is ready to merge.',
    toolCalls: [{ tool_name: 'bash', input: { command: 'npm test' }, output: '', error: 'Command failed with exit code 1' }],
  };

  it('the missing evidence is a second thing to fix, never "not a pass" said over a failure, and never blamed on a requirement nobody set', async () => {
    const r = await engine({}, { cost_threshold: 0.05 }).evaluateAll(failing);
    expect(r.verdict).toMatchObject({ state: 'fail', basis: 'risk_over_loss' });
    const texts = (r.interpretations ?? []).map((i) => i.text);
    expect(texts).toContain('Also not checked: cost_under_threshold could not run without cost (this deployment asks for it). Send cost so it can be.');
    expect(texts.some((t) => t.startsWith('Not checked, which is not a pass'))).toBe(false);
    expect(texts.some((t) => t.includes('evidence that was asked for or promised is not in the record (cost)'))).toBe(true);
    expect(texts.some((t) => t.includes('this deployment requires'))).toBe(false);
  });

  it('a critical check that skipped is never called clean on a verdict that failed', async () => {
    const r = await engine({ criticalRules: ['no_tool_loop'], onCriticalSkipped: 'pass' }).evaluateAll({ ...failing, toolCalls: undefined, output: `${failing.output} TODO: confirm the offset case.` });
    const skippedCritical = (r.interpretations ?? []).find((i) => i.text.startsWith('Critical check(s) did not judge this output'));
    if (r.verdict!.state === 'pass') expect(skippedCritical?.text).toContain('This verdict is clean on everything else');
    else expect(skippedCritical?.text).toContain('The verdict above says nothing about what they check.');
    // On a verdict that fails outright, with a critical rule that skipped for nothing to judge:
    const vetoed = await engine().evaluateAll({ input: 'Summarise the ticket.', output: 'The reporter is Marisol Quintero, SSN 123-45-6789.', toolCalls: undefined });
    expect(vetoed.verdict!.state).toBe('fail');
    for (const i of vetoed.interpretations ?? []) expect(i.text).not.toContain('This verdict is clean on everything else');
  });
});
