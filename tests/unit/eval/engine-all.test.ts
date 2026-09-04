import { describe, it, expect } from 'vitest';
import { EvalEngine, ALL_EVAL_TYPES } from '../../../src/eval/engine.js';
import { createCustomRule } from '../../../src/eval/rules/custom.js';
import type { EvalRule } from '../../../src/types/eval.js';

/*
 * eval_type="all" (#370 item 3) and the rule-identity plumbing (#373 item
 * 3) at the engine level. The MCP-facing contract is covered in
 * tests/integration/tool-contracts.test.ts; this file pins the arithmetic.
 */

const CLEAN_OUTPUT =
  'The quarterly report is attached. Revenue grew in every region, and the outlook remains stable for next year.';
const LEAKY_OUTPUT =
  'The quarterly report is attached. Revenue grew in every region. For the record, the customer SSN is 536-22-8145.';

function keywordRule(name: string, keyword: string): EvalRule {
  return createCustomRule({ name, type: 'contains_keywords', config: { keywords: [keyword] } });
}

describe('EvalEngine.evaluateAll', () => {
  it('runs every bundle in one pass and reports a per-category breakdown', () => {
    const engine = new EvalEngine(0.7);
    const result = engine.evaluateAll({ output: CLEAN_OUTPUT, input: 'quarterly report revenue', costUsd: 0.01 });

    expect(result.eval_type).toBe('all');
    // Every built-in bundle contributed at least one rule result.
    const categories = new Set(result.rule_results.map((r) => r.category));
    expect(categories).toEqual(new Set(['completeness', 'relevance', 'safety', 'cost']));
    // The breakdown lists exactly the bundles that had rules — no 'custom'
    // entry, because nothing was deployed or passed inline.
    expect(Object.keys(result.categories ?? {})).toEqual(['completeness', 'relevance', 'safety', 'cost']);
    for (const type of ['completeness', 'relevance', 'safety', 'cost'] as const) {
      const cat = result.categories![type]!;
      expect(cat.rules_evaluated + cat.rules_skipped).toBe(
        result.rule_results.filter((r) => r.category === type).length,
      );
      expect(typeof cat.score).toBe('number');
      expect(typeof cat.passed).toBe('boolean');
    }
    expect(result.passed).toBe(true);
    expect(result.critical_failures).toBeUndefined();
  });

  it('applies the critical veto across bundles: a PII leak in the safety slice fails the whole verdict', () => {
    const engine = new EvalEngine(0.7);
    const result = engine.evaluateAll({ output: LEAKY_OUTPUT, input: 'quarterly report revenue', costUsd: 0.01 });

    // The weighted average over 11+ rules clears the threshold comfortably —
    // which is exactly the situation the veto exists for.
    expect(result.score).toBeGreaterThanOrEqual(0.7);
    expect(result.passed).toBe(false);
    expect(result.critical_failures).toEqual(['no_pii']);
    // Per-category: safety vetoed, the others untouched.
    expect(result.categories!.safety!.passed).toBe(false);
    expect(result.categories!.safety!.critical_failures).toEqual(['no_pii']);
    expect(result.categories!.completeness!.passed).toBe(true);
    expect(result.categories!.completeness!.critical_failures).toBeUndefined();
  });

  it('reports a bundle with no usable context as NOT judged (passed: null), not as failing (#406)', () => {
    const engine = new EvalEngine(0.7);
    // No input → both relevance rules skip; no cost → both cost rules skip.
    const result = engine.evaluateAll({ output: CLEAN_OUTPUT });
    // Before: passed:false, score:0 — a reader regrouping by category saw
    // cost "failing" on a call that carried no cost data. Null is the
    // honest value: neither passing nor failing.
    expect(result.categories!.relevance).toEqual({
      score: null,
      passed: null,
      rules_evaluated: 0,
      rules_skipped: 2,
      insufficient_data: true,
    });
    expect(result.categories!.cost).toEqual({
      score: null,
      passed: null,
      rules_evaluated: 0,
      rules_skipped: 3,
      insufficient_data: true,
    });
    // A judged bundle keeps its boolean/number, unchanged.
    expect(typeof result.categories!.completeness!.passed).toBe('boolean');
    expect(typeof result.categories!.completeness!.score).toBe('number');
    // Skipped rules are excluded from the weighted score, as in a single
    // bundle — the unjudged bundles do not count toward the overall verdict.
    expect(result.insufficient_data).toBe(false);
    expect(result.passed).toBe(true);
  });

  it('keeps the TOP-LEVEL verdict boolean and fails closed when nothing at all was judged', () => {
    const engine = new EvalEngine(0.7);
    // Only a cost bundle and no cost data: every rule skips. Inside the
    // breakdown that is passed:null; at the top level a gate keyed on
    // `passed` must fail closed, with insufficient_data as the "unknown"
    // marker — the same shape a single-bundle evaluate() reports.
    const single = engine.evaluate('cost', { output: CLEAN_OUTPUT });
    expect(single).toMatchObject({ passed: false, score: 0, insufficient_data: true, rules_evaluated: 0 });
    expect(single.categories).toBeUndefined();
  });

  it('includes rules deployed under "custom" and inline custom_rules in a "custom" category, and stamps ruleId', () => {
    const engine = new EvalEngine(0.7);
    engine.registerRule('custom', keywordRule('deployed-keyword', 'quarterly'), 'rule-deadbeef');
    engine.registerRule('safety', keywordRule('deployed-safety', 'stable'), 'rule-cafebabe');

    const result = engine.evaluateAll({ output: CLEAN_OUTPUT }, [
      { name: 'inline-keyword', type: 'contains_keywords', config: { keywords: ['report'] } },
    ]);

    const byName = new Map(result.rule_results.map((r) => [r.ruleName, r]));
    expect(byName.get('deployed-keyword')).toMatchObject({ ruleId: 'rule-deadbeef', category: 'custom', passed: true });
    expect(byName.get('deployed-safety')).toMatchObject({ ruleId: 'rule-cafebabe', category: 'safety', passed: true });
    expect(byName.get('inline-keyword')).toMatchObject({ category: 'custom', passed: true });
    expect(byName.get('inline-keyword')!.ruleId).toBeUndefined();
    // Built-ins carry no ruleId.
    expect(byName.get('no_pii')!.ruleId).toBeUndefined();
    expect(result.categories!.custom).toEqual(
      expect.objectContaining({ rules_evaluated: 2, rules_skipped: 0, passed: true }),
    );
  });

  it('walks the bundles in the documented order', () => {
    expect([...ALL_EVAL_TYPES]).toEqual(['completeness', 'relevance', 'safety', 'cost', 'custom']);
  });
});

describe('EvalEngine rule identity', () => {
  it('single-bundle evaluate stamps ruleId on deployed rules and leaves category off', () => {
    const engine = new EvalEngine(0.7);
    engine.registerRule('completeness', keywordRule('canary', 'report'), 'rule-00000001');
    const result = engine.evaluate('completeness', { output: CLEAN_OUTPUT });
    const canary = result.rule_results.find((r) => r.ruleName === 'canary')!;
    expect(canary.ruleId).toBe('rule-00000001');
    expect(canary.category).toBeUndefined();
    // The id sits right after the name so a reader sees it first.
    expect(Object.keys(canary).slice(0, 2)).toEqual(['ruleName', 'ruleId']);
  });

  it('two rules sharing a name are distinguishable by ruleId', () => {
    const engine = new EvalEngine(0.7);
    engine.registerRule('completeness', keywordRule('same-name', 'report'), 'rule-aaaaaaaa');
    engine.registerRule('completeness', keywordRule('same-name', 'zebra'), 'rule-bbbbbbbb');
    const result = engine.evaluate('completeness', { output: CLEAN_OUTPUT });
    const twins = result.rule_results.filter((r) => r.ruleName === 'same-name');
    expect(twins.map((r) => [r.ruleId, r.passed])).toEqual([
      ['rule-aaaaaaaa', true],
      ['rule-bbbbbbbb', false],
    ]);
  });

  it('registerRule is idempotent by id — re-registering replaces instead of stacking', () => {
    const engine = new EvalEngine(0.7);
    engine.registerRule('completeness', keywordRule('toggle-me', 'report'), 'rule-11111111');
    engine.registerRule('completeness', keywordRule('toggle-me', 'report'), 'rule-11111111');
    const result = engine.evaluate('completeness', { output: CLEAN_OUTPUT });
    expect(result.rule_results.filter((r) => r.ruleName === 'toggle-me')).toHaveLength(1);
    expect(engine.hasRule('rule-11111111')).toBe(true);
    expect(engine.unregisterRule('rule-11111111')).toBe(true);
    expect(engine.hasRule('rule-11111111')).toBe(false);
    expect(engine.evaluate('completeness', { output: CLEAN_OUTPUT }).rule_results.some((r) => r.ruleName === 'toggle-me')).toBe(false);
  });
});
