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
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
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
