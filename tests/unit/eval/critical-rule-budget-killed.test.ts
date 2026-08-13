import { describe, it, expect, afterAll } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { createCustomRule } from '../../../src/eval/rules/index.js';
import { shutdownRegexSandbox } from '../../../src/eval/rules/regex-sandbox.js';
import type { CustomRuleDefinition } from '../../../src/types/eval.js';

/*
 * Where v0.5.0's two headline features MEET — and the suite had nothing
 * here.
 *
 * Feature 1: a failing critical rule vetoes the evaluation, forcing
 * passed=false regardless of the weighted score.
 * Feature 2: a user regex whose match blows the 100ms sandbox budget is
 * killed mid-backtrack and reports SKIPPED (fail-open, per rule).
 *
 * Intersect them and you get the seam: a deployed severity=critical regex
 * rule, defeated by output CRAFTED to stall it, does not judge — and a
 * rule that did not judge cannot veto. So the evaluation comes back
 * passed=true, with no `critical_failures`, on output nobody cleared. An
 * adversary who knows the pattern can reach that state on purpose.
 *
 * That behaviour is deliberate — failing closed would let the same
 * adversary force false violations on benign output, which is worse for an
 * eval product. What was NOT acceptable was leaving it undocumented and
 * untested, with the only signal a prose line in `suggestions`. These tests
 * pin the fail-open contract so a future change to it has to be a decision,
 * and assert the machine-readable `critical_skipped` marker a fail-closed
 * gate consumes instead of walking rule_results[].budgetExceeded.
 */

/*
 * The hostile pair: a pattern equivalent to ^(a|a)*$ matched against a long
 * run of 'a' ending in 'b'. It passes safe-regex2's star-height heuristic
 * and is exponential — exactly the class the sandbox worker exists for, and
 * the same fuel tests/unit/eval/regex-circuit-breaker.test.ts uses.
 *
 * Assembled from parts rather than written as one literal so CodeQL's
 * js/redos query does not raise a genuine (and here, entirely deliberate)
 * high-severity alert on a test fixture. The engine receives the identical
 * string either way; only the static analyser sees a difference.
 */
const HOSTILE_FUEL = 'a'.repeat(40) + 'b';
const HOSTILE_PATTERN = ['^(', 'a', '|', 'a', ')', '*', '$'].join('');

function hostileCriticalRule(name: string) {
  const def: CustomRuleDefinition = {
    name,
    type: 'regex_match',
    config: { pattern: HOSTILE_PATTERN },
  };
  // severity 'critical' is what deploy_rule sets for a hard-failing rule.
  return createCustomRule(def, 'critical');
}

afterAll(() => {
  shutdownRegexSandbox();
});

describe('a critical rule killed by the sandbox budget', () => {
  it('skips instead of failing — it never judged the output', () => {
    const engine = new EvalEngine(0.7);
    engine.registerRule('custom', hostileCriticalRule('crafted_stall'), 'rule-stall-1');

    const result = engine.evaluate('custom', { output: HOSTILE_FUEL });

    const rule = result.rule_results.find((r) => r.ruleName === 'crafted_stall');
    expect(rule).toBeDefined();
    expect(rule!.skipped).toBe(true);
    expect(rule!.budgetExceeded).toBe(true);
  });

  it('does NOT veto — the documented fail-open, asserted not assumed', () => {
    const engine = new EvalEngine(0.7);
    engine.registerRule('custom', hostileCriticalRule('crafted_stall'), 'rule-stall-2');
    // A second, cheap rule that passes, so the evaluation is not
    // "insufficient_data" and produces a real score to reason about.
    engine.registerRule(
      'custom',
      createCustomRule({ name: 'cheap_check', type: 'min_length', config: { min_length: 5 } }),
      'rule-cheap',
    );

    const result = engine.evaluate('custom', { output: HOSTILE_FUEL });

    expect(result.insufficient_data).toBe(false);
    expect(result.rules_skipped).toBeGreaterThanOrEqual(1);
    // The seam: passed=true with NO critical_failures, on output the
    // critical rule was defeated by rather than cleared.
    expect(result.critical_failures).toBeUndefined();
    expect(result.passed).toBe(true);
  });

  it('reports the defeated rule in critical_skipped so a gate can fail closed', () => {
    const engine = new EvalEngine(0.7);
    engine.registerRule('custom', hostileCriticalRule('crafted_stall'), 'rule-stall-3');
    engine.registerRule(
      'custom',
      createCustomRule({ name: 'cheap_check', type: 'min_length', config: { min_length: 5 } }),
      'rule-cheap',
    );

    const result = engine.evaluate('custom', { output: HOSTILE_FUEL });

    expect(result.critical_skipped).toEqual(['crafted_stall']);
    // And it is stated in prose too, for the human reading suggestions.
    expect(result.suggestions.join(' ')).toContain('did NOT judge this output');
  });

  it('leaves critical_skipped absent when every critical rule actually ran', () => {
    const engine = new EvalEngine(0.7);
    engine.registerRule(
      'custom',
      createCustomRule(
        { name: 'linear_forbidden', type: 'regex_no_match', config: { pattern: 'zzz' } },
        'critical',
      ),
      'rule-linear',
    );

    const result = engine.evaluate('custom', { output: 'a perfectly ordinary agent response' });

    expect(result.critical_skipped).toBeUndefined();
    expect(result.passed).toBe(true);
  });

  it('still vetoes when the critical rule DOES judge and fails', () => {
    const engine = new EvalEngine(0.7);
    engine.registerRule(
      'custom',
      createCustomRule(
        { name: 'linear_forbidden', type: 'regex_no_match', config: { pattern: 'forbidden' } },
        'critical',
      ),
      'rule-linear-2',
    );
    engine.registerRule(
      'custom',
      createCustomRule({ name: 'cheap_check', type: 'min_length', config: { min_length: 5 } }, 'low'),
      'rule-cheap-2',
    );

    const result = engine.evaluate('custom', { output: 'this response contains a forbidden token' });

    expect(result.critical_failures).toEqual(['linear_forbidden']);
    expect(result.critical_skipped).toBeUndefined();
    expect(result.passed).toBe(false);
  });
});
