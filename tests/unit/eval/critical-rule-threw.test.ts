/*
 * A rule that throws was asked and gave no answer.
 *
 * The engine catches a rule that throws and records it as not checked, so
 * that one rule's error does not turn every other rule's answer into an
 * error. For a rule that vetoes or gates, "gave no answer" has to stop the
 * verdict from passing, as eval.onCriticalSkipped says. It did not: the
 * caught throw was stamped like a rule with nothing to judge, and the
 * verdict passed clean (#1012). A rule whose configuration is refused was
 * always handled the other way, and the two are held side by side here.
 */
import { describe, expect, it } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { createCustomRule } from '../../../src/eval/rules/index.js';
import { builtInRules } from '../../../src/eval/criticality.js';
import { deriveCoverage } from '../../../src/eval/verdict.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import type { EvalContext, EvalRule, EvalRuleResult } from '../../../src/types/eval.js';
import type { RuleSeverity } from '../../../src/types/custom-rule.js';

const CLEAN: EvalContext = {
  input: 'What is the capital of France?',
  output: 'The capital of France is Paris, which has been the seat of its government for centuries.',
};

/** A deployed rule made to throw on every output: a policy whose evaluate is replaced, as a defect in a rule would have it. */
function throwing(name: string, severity?: RuleSeverity): EvalRule {
  const rule = createCustomRule({ name, type: 'min_length', config: { min_length: 5 } }, severity);
  return {
    ...rule,
    evaluate(): EvalRuleResult {
      throw new TypeError("Cannot read properties of undefined (reading 'toLowerCase')");
    },
  };
}

const engineWith = (rule: EvalRule, overrides?: ConstructorParameters<typeof EvalEngine>[2]) => {
  const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, overrides ?? defaultConfig.eval);
  engine.registerRule('custom', rule, `rule-${rule.name}`);
  return engine;
};
const rowOf = (result: { rule_results: EvalRuleResult[] }, name: string) => result.rule_results.find((r) => r.ruleName === name)!;

describe('a rule that throws while it judges', () => {
  it('is recorded as asked and unanswered: skipped, threw, defeated', async () => {
    const result = await engineWith(throwing('gate_that_throws', 'critical')).evaluateAll(CLEAN);
    const row = rowOf(result, 'gate_that_throws');
    expect(row.skipped).toBe(true);
    expect(row.threw).toBe(true);
    expect(row.skipClass).toBe('defeated');
    expect(row.state).toBe('not_checked');
    expect(row.skipReason).toBe('the rule threw on this input');
    expect(row.message).toContain('This rule failed while evaluating the output and gave no answer');
  });

  it('deployed to gate, makes the verdict unknown and names the rule', async () => {
    for (const severity of ['critical', 'high'] as const) {
      const result = await engineWith(throwing('gate_that_throws', severity)).evaluateAll(CLEAN);
      expect(result.verdict, severity).toMatchObject({ state: 'unknown', basis: 'critical_unknown', by: ['gate_that_throws'] });
      expect(result.passed, severity).toBe(false);
      expect(result.critical_skipped, severity).toContain('gate_that_throws');
      // Nothing was detected, so nothing is a failure.
      expect(result.critical_failures, severity).toBeUndefined();
      expect(result.interpretations?.some((i) => i.configKey === 'eval.onCriticalSkipped' && i.text.includes('gate_that_throws')), severity).toBe(true);
    }
  });

  it('follows eval.onCriticalSkipped: fail fails, pass accepts the risk', async () => {
    const failing = await engineWith(throwing('gate_that_throws', 'critical'), { ...defaultConfig.eval, onCriticalSkipped: 'fail' }).evaluateAll(CLEAN);
    expect(failing.verdict).toMatchObject({ state: 'fail', basis: 'critical_unknown', by: ['gate_that_throws'] });
    expect(failing.passed).toBe(false);
    const accepting = await engineWith(throwing('gate_that_throws', 'critical'), { ...defaultConfig.eval, onCriticalSkipped: 'pass' }).evaluateAll(CLEAN);
    expect(accepting.verdict?.state).toBe('pass');
    expect(accepting.passed).toBe(true);
    // The row says what happened either way.
    expect(rowOf(accepting, 'gate_that_throws')).toMatchObject({ skipped: true, threw: true, skipClass: 'defeated' });
  });

  it('gives the verdict a refused configuration gives: the two ways a gate cannot answer read alike', async () => {
    const threw = await engineWith(throwing('gate', 'critical')).evaluateAll(CLEAN);
    // A policy that binds an argument by its name is refused: a binding is keyed by JSON Pointer.
    const refused = await engineWith(createCustomRule({ name: 'gate', type: 'action_policy', config: { deny: [{ tool: 'bash', args: { command: 'rm *' } }] } }, 'critical')).evaluateAll({
      ...CLEAN,
      toolCalls: [{ tool_name: 'read_file', input: { path: 'a.ts' }, output: 'x' }],
    });
    expect(rowOf(refused, 'gate').skipClass).toBe('config_invalid');
    for (const result of [threw, refused]) expect(result.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown', by: ['gate'] });
  });

  it('that only reports changes no verdict', async () => {
    const without = await new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval).evaluateAll(CLEAN);
    for (const severity of [undefined, 'low', 'medium'] as const) {
      const result = await engineWith(throwing('advisor_that_throws', severity)).evaluateAll(CLEAN);
      expect(rowOf(result, 'advisor_that_throws'), String(severity)).toMatchObject({ skipped: true, threw: true, skipClass: 'defeated' });
      expect(result.verdict?.state, String(severity)).toBe(without.verdict?.state);
      expect(result.verdict?.basis, String(severity)).toBe(without.verdict?.basis);
      expect(result.passed, String(severity)).toBe(without.passed);
    }
  });

  it('a built-in critical rule that throws makes the verdict unknown too', async () => {
    // no_pii ships critical. Its evaluate is replaced for this one evaluation, as a defect inside it would have it, and put back.
    const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    const builtIn = builtInRules().find((r) => r.name === 'no_pii')!;
    const original = builtIn.evaluate;
    builtIn.evaluate = () => {
      throw new Error('a defect inside the rule');
    };
    try {
      const result = await engine.evaluateAll(CLEAN);
      expect(rowOf(result, 'no_pii')).toMatchObject({ skipped: true, threw: true, skipClass: 'defeated', critical: true });
      expect(result.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown' });
      expect(result.verdict?.by).toContain('no_pii');
      expect(result.passed).toBe(false);
      // The other safety rules judged, so the question is judged in part, and the part that was not names its reason.
      const safe = result.coverage?.questions.find((q) => q.id === 'safe_output');
      expect(safe).toMatchObject({ status: 'judged' });
      expect(safe?.why).toContain('the rule threw on this input');
    } finally {
      builtIn.evaluate = original;
    }
  });

  it('a question no rule could judge says why in the cause\'s own words', () => {
    const row = (flags: Partial<EvalRuleResult>): EvalRuleResult => ({ ruleName: 'r', passed: false, score: 0, message: 'not judged', skipped: true, skipClass: 'defeated', question: 'safe_output', ...flags });
    const why = (rows: EvalRuleResult[]) => deriveCoverage(rows).questions.find((q) => q.id === 'safe_output');
    expect(why([row({ ruleName: 'a', threw: true })])).toMatchObject({ status: 'unjudged', why: 'defeated: a could not judge this output (the rule threw)' });
    expect(why([row({ ruleName: 'b', evidenceIncomplete: true })])).toMatchObject({ status: 'unjudged', why: 'defeated: b could not judge this output (the evidence it reads was cut)' });
    expect(why([row({ ruleName: 'c', budgetExceeded: true })])).toMatchObject({ status: 'unjudged', why: 'defeated: c could not judge this output (sandbox budget)' });
    // A row stored before the causes were kept says only that it was defeated, and reads as the one cause there was then.
    expect(why([row({ ruleName: 'd' })])).toMatchObject({ status: 'unjudged', why: 'defeated: d could not judge this output (sandbox budget)' });
    expect(why([row({ ruleName: 'a', threw: true }), row({ ruleName: 'c', budgetExceeded: true })])).toMatchObject({ why: 'defeated: a, c could not judge this output (the rule threw; sandbox budget)' });
  });
});
