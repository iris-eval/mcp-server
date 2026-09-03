import { describe, it, expect } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { createCustomRule } from '../../../src/eval/rules/custom.js';
import { costUnderThreshold } from '../../../src/eval/rules/cost.js';

/*
 * A custom cost_threshold rule with no cost data has not judged anything.
 *
 * The rule used to read a missing `context.costUsd` as 0 and pass any
 * non-negative threshold with score 1. The built-in sibling
 * (cost_under_threshold, cost.ts) skips with a skipReason in the same
 * situation, and the file's own configError precedent says a rule that
 * cannot judge must skip so it neither deflates the score nor vetoes on
 * evidence it never gathered — the fail-open here ran the other way: an
 * operator who deployed `cost_threshold` at severity critical to hard-fail
 * anything over $0.50 got passed:true on every evaluate_output call that
 * omitted cost_usd, and the veto never fired.
 */

function costRule(maxCost = 0.5, severity?: 'low' | 'medium' | 'high' | 'critical') {
  return createCustomRule(
    { name: 'cost_ceiling', type: 'cost_threshold', config: { max_cost: maxCost } },
    severity,
  );
}

describe('custom cost_threshold rule without cost data', () => {
  it('skips with a skipReason instead of passing', () => {
    const result = costRule().evaluate({ output: 'no cost attached' });
    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.skipReason).toBe('context.costUsd not provided');
    // Not a config problem — the definition is fine, the input lacked data.
    expect(result.configInvalid).toBeUndefined();
  });

  it('mirrors the built-in cost_under_threshold skip contract', () => {
    const builtIn = costUnderThreshold.evaluate({ output: 'x' });
    const custom = costRule().evaluate({ output: 'x' });
    expect(custom.skipped).toBe(builtIn.skipped);
    expect(custom.skipReason).toBe(builtIn.skipReason);
  });

  it('still judges a cost of exactly zero (zero is data, not absence)', () => {
    const result = costRule().evaluate({ output: 'x', costUsd: 0 });
    expect(result.skipped).toBeUndefined();
    expect(result.passed).toBe(true);
  });

  it('still fails a cost over the threshold', () => {
    const result = costRule().evaluate({ output: 'x', costUsd: 0.75 });
    expect(result.skipped).toBeUndefined();
    expect(result.passed).toBe(false);
  });
});

describe('a critical cost_threshold rule that could not run', () => {
  it('is reported in critical_skipped, not silently passed', () => {
    const engine = new EvalEngine(0.7);
    engine.registerRule('safety', costRule(0.5, 'critical'), 'rule-cost');

    const result = engine.evaluate('safety', { output: 'a clean response with no PII in it' });

    const rule = result.rule_results.find((r) => r.ruleName === 'cost_ceiling');
    expect(rule?.skipped).toBe(true);
    expect(result.critical_failures).toBeUndefined();
    expect(result.critical_skipped).toEqual(['cost_ceiling']);
    expect(result.suggestions.join(' ')).toContain('did NOT judge this output');
  });

  it('is still named in critical_skipped when it was the ONLY rule (insufficient_data path)', () => {
    const engine = new EvalEngine(0.7);
    engine.registerRule('custom', costRule(0.5, 'critical'), 'rule-cost');

    const result = engine.evaluate('custom', { output: 'no cost attached' });

    // Every rule skipped → no verdict. The description promises every
    // critical rule that skipped is named, on this path too.
    expect(result.insufficient_data).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.critical_skipped).toEqual(['cost_ceiling']);
  });

  it('vetoes when cost data is present and over the ceiling', () => {
    const engine = new EvalEngine(0.7);
    engine.registerRule('safety', costRule(0.5, 'critical'), 'rule-cost');

    const result = engine.evaluate('safety', {
      output: 'a clean response with no PII in it',
      costUsd: 0.75,
    });

    expect(result.passed).toBe(false);
    expect(result.critical_failures).toEqual(['cost_ceiling']);
    expect(result.critical_skipped).toBeUndefined();
  });
});
