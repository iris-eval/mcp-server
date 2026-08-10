import { describe, it, expect } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { createCustomRule } from '../../../src/eval/rules/index.js';
import type { CustomRuleDefinition, EvalContext } from '../../../src/types/eval.js';

/*
 * evaluate_output's description promises, twice, that inline custom_rules
 * are ADDITIVE:
 *
 *   "custom_rules — fires REGARDLESS of eval_type"
 *   "otherwise both your rules AND the eval_type bundle run together"
 *
 * The engine did neither. `evalType === 'custom' && customRules` meant a
 * rule passed alongside eval_type="safety" was silently discarded, and a
 * rule passed alongside eval_type="custom" REPLACED the user's deployed
 * library for that call. Both returned a plausible score with no warning,
 * which is the worst shape for an eval tool: the caller cannot tell the
 * difference between "your rule passed" and "your rule never ran".
 */

const ctx: EvalContext = {
  output: 'Some agent output text that is reasonably long for evaluation purposes.',
  input: 'a question',
};

const inlineRule: CustomRuleDefinition = {
  name: 'my_inline_rule',
  type: 'contains_keywords',
  config: { keywords: ['definitely-not-present-anywhere'] },
};

function ranRules(result: { rule_results: Array<{ ruleName: string }> }): string[] {
  return result.rule_results.map((r) => r.ruleName);
}

describe('inline custom_rules are additive', () => {
  it('fires alongside a built-in bundle (eval_type="safety")', () => {
    const engine = new EvalEngine();
    const result = engine.evaluate('safety', ctx, [inlineRule]);

    expect(ranRules(result)).toContain('my_inline_rule');
    // …and the safety bundle still ran.
    expect(ranRules(result)).toContain('no_pii');
  });

  it('fires alongside the completeness bundle too', () => {
    const engine = new EvalEngine();
    const result = engine.evaluate('completeness', ctx, [inlineRule]);

    expect(ranRules(result)).toContain('my_inline_rule');
    expect(ranRules(result).length).toBeGreaterThan(1);
  });

  it('does NOT evict deployed rules when eval_type="custom"', () => {
    /*
     * Deployed rules are registered at server boot (src/index.ts). Passing
     * one ad-hoc rule used to disable the entire deployed library for that
     * call — the user's own standing rules silently stopped applying.
     */
    const engine = new EvalEngine();
    engine.registerRule(
      'custom',
      createCustomRule({
        name: 'my_deployed_rule',
        type: 'min_length',
        config: { min_length: 5 },
      }),
    );

    const withInline = engine.evaluate('custom', ctx, [inlineRule]);
    expect(ranRules(withInline)).toContain('my_deployed_rule');
    expect(ranRules(withInline)).toContain('my_inline_rule');
  });

  it('runs no built-in bundle for eval_type="custom" (the documented "ONLY these")', () => {
    const engine = new EvalEngine();
    const result = engine.evaluate('custom', ctx, [inlineRule]);

    expect(ranRules(result)).toEqual(['my_inline_rule']);
  });

  it('still evaluates the plain bundle when no custom rules are passed', () => {
    const engine = new EvalEngine();
    const result = engine.evaluate('safety', ctx);

    expect(ranRules(result)).toContain('no_pii');
    expect(ranRules(result)).not.toContain('my_inline_rule');
  });
});
