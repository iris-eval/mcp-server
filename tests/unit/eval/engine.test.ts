import { describe, it, expect } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { passingContext, failingContext } from '../../fixtures/sample-evals.js';

describe('EvalEngine', () => {
  it('should return passing result for good output', () => {
    const engine = new EvalEngine(0.7);
    const result = engine.evaluate('completeness', passingContext);
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0.7);
    expect(result.rule_results.length).toBeGreaterThan(0);
  });

  it('should return failing result for empty output', () => {
    const engine = new EvalEngine(0.7);
    const result = engine.evaluate('completeness', failingContext);
    expect(result.passed).toBe(false);
    expect(result.score).toBeLessThan(0.7);
  });

  it('should respect custom threshold', () => {
    const engine = new EvalEngine(0.95);
    const result = engine.evaluate('completeness', passingContext);
    // Even a good output may not pass a very high threshold
    expect(result.score).toBeGreaterThan(0);
  });

  it('should generate suggestions for failing rules', () => {
    const engine = new EvalEngine(0.7);
    const result = engine.evaluate('completeness', failingContext);
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it('should handle custom eval type with no rules', () => {
    const engine = new EvalEngine(0.7);
    const result = engine.evaluate('custom', passingContext);
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.insufficient_data).toBe(true);
  });

  it('should handle custom rules', () => {
    const engine = new EvalEngine(0.7);
    const result = engine.evaluate('custom', passingContext, [
      { name: 'min_len', type: 'min_length', config: { length: 10 } },
    ]);
    expect(result.passed).toBe(true);
    expect(result.rule_results[0].ruleName).toBe('min_len');
  });

  it('should register additional rules', () => {
    const engine = new EvalEngine(0.7);
    engine.registerRule('completeness', {
      name: 'custom_rule',
      description: 'A custom rule',
      evalType: 'completeness',
      weight: 1,
      evaluate: () => ({ ruleName: 'custom_rule', passed: true, score: 1, message: 'Custom OK' }),
    });
    const result = engine.evaluate('completeness', passingContext);
    const customResult = result.rule_results.find(r => r.ruleName === 'custom_rule');
    expect(customResult).toBeDefined();
    expect(customResult!.passed).toBe(true);
  });

  it('should handle multiple custom rules without NaN scores', () => {
    const engine = new EvalEngine(0.7);
    const result = engine.evaluate('custom', passingContext, [
      { name: 'min_len', type: 'min_length', config: { min_length: 10 } },
      { name: 'has_pattern', type: 'regex_match', config: { pattern: '.' } },
    ]);
    expect(result.passed).toBe(true);
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.rule_results).toHaveLength(2);
  });

  it('should accept min_length with either config key name', () => {
    const engine = new EvalEngine(0.7);
    const r1 = engine.evaluate('custom', passingContext, [
      { name: 'old_key', type: 'min_length', config: { length: 10 } },
    ]);
    const r2 = engine.evaluate('custom', passingContext, [
      { name: 'new_key', type: 'min_length', config: { min_length: 10 } },
    ]);
    expect(r1.passed).toBe(true);
    expect(r2.passed).toBe(true);
  });

  it('should not produce NaN when custom rule config is invalid', () => {
    const engine = new EvalEngine(0.7);
    const result = engine.evaluate('custom', passingContext, [
      { name: 'bad_config', type: 'min_length', config: {} },
      { name: 'good_rule', type: 'regex_match', config: { pattern: '.' } },
    ]);
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  // Regression: a rule whose CONFIG is broken has not judged the output — it
  // could not run. Scoring it 0 conflated "your agent failed" with "this rule
  // is broken" AND silently deflated every aggregate score for as long as the
  // rule stayed deployed. Config errors must be SKIPPED (excluded from the
  // weighted average), the same contract expected_coverage uses.
  it('skips misconfigured custom rules instead of scoring them 0', () => {
    const engine = new EvalEngine(0.7);
    const result = engine.evaluate('custom', passingContext, [
      { name: 'broken', type: 'min_length', config: {} },
      { name: 'good_rule', type: 'regex_match', config: { pattern: '.' } },
    ]);
    const broken = result.rule_results.find((r) => r.ruleName === 'broken');
    expect(broken?.skipped).toBe(true);
    expect(broken?.skipReason).toMatch(/min_length rule requires/);
    // The one rule that COULD run passed, so the aggregate must be a clean
    // 1 — not dragged toward 0.5 by the rule that never executed.
    expect(result.score).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('skips every custom-rule config-error branch rather than failing the output', () => {
    const engine = new EvalEngine(0.7);
    const broken = [
      { name: 'no_min', type: 'min_length' as const, config: {} },
      { name: 'no_max', type: 'max_length' as const, config: {} },
      { name: 'no_kw_in', type: 'contains_keywords' as const, config: {} },
      { name: 'no_kw_ex', type: 'excludes_keywords' as const, config: {} },
      { name: 'no_cost', type: 'cost_threshold' as const, config: {} },
      { name: 'bad_regex', type: 'regex_match' as const, config: { pattern: '(' } },
    ];
    const result = engine.evaluate('custom', passingContext, broken);
    for (const rule of broken) {
      const r = result.rule_results.find((x) => x.ruleName === rule.name);
      expect(r?.skipped, `${rule.name} should be skipped`).toBe(true);
    }
    // Every rule was unrunnable — the engine must report insufficient data,
    // never a confident "your output scored 0".
    expect(result.rules_skipped).toBe(broken.length);
  });

  // The deploy_rule tool description and docs/api-reference.md shipped
  // `config.min` / `config.max_usd` while the evaluator read
  // `config.min_length` / `config.max_cost`. Rules built from our own
  // documentation deployed fine and then never worked. The documented
  // spellings are honoured as aliases so those rules start working.
  it('honours the config key spellings our docs shipped', () => {
    const engine = new EvalEngine(0.7);
    expect(engine.evaluate('custom', passingContext, [
      { name: 'documented_min', type: 'min_length', config: { min: 10 } },
    ]).passed).toBe(true);

    const costResult = engine.evaluate('custom', { ...passingContext, costUsd: 0.001 }, [
      { name: 'documented_cost', type: 'cost_threshold', config: { max_usd: 1 } },
    ]);
    const costRule = costResult.rule_results.find((r) => r.ruleName === 'documented_cost');
    expect(costRule?.skipped).toBeFalsy();
    expect(costRule?.passed).toBe(true);
  });

  it('should generate unique eval IDs', () => {
    const engine = new EvalEngine(0.7);
    const r1 = engine.evaluate('completeness', passingContext);
    const r2 = engine.evaluate('completeness', passingContext);
    expect(r1.id).not.toBe(r2.id);
  });

  it('should evaluate all eval types', () => {
    const engine = new EvalEngine(0.7);
    for (const type of ['completeness', 'relevance', 'safety', 'cost'] as const) {
      const result = engine.evaluate(type, passingContext);
      expect(result.eval_type).toBe(type);
      expect(result.rule_results.length).toBeGreaterThan(0);
    }
  });
});
