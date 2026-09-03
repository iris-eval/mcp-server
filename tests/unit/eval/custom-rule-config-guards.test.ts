import { describe, it, expect } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { createCustomRule } from '../../../src/eval/rules/custom.js';
import type { CustomRuleDefinition } from '../../../src/types/eval.js';

/*
 * "The eval itself never throws" — evaluate_output's description.
 *
 * The inline custom_rules schema accepts any config record, so a rule
 * like `{type: "regex_match", config: {}}` passes Zod and reaches the
 * evaluator, where `definition.config.pattern as string` was a compile-
 * time cast only: normalizeRegexSource called `.match()` on undefined and
 * the TypeError escaped the engine's rule loop. The whole evaluate_output
 * call failed (an MCP tool error, or a masked 500 over HTTP) instead of
 * reporting a skipped rule. `keywords: [1, 2]` had the same shape of bug
 * through `.toLowerCase()`.
 *
 * Every case below is a definition that Zod lets through. Each must come
 * back as a configError result — skipped, configInvalid, with a message
 * naming the field — and the engine must finish the evaluation.
 */

const brokenRegexConfigs: Array<[string, Record<string, unknown>]> = [
  ['missing pattern', {}],
  ['null pattern', { pattern: null }],
  ['numeric pattern', { pattern: 123 }],
  ['empty pattern', { pattern: '' }],
  ['array pattern', { pattern: ['a'] }],
  ['object flags', { pattern: 'ok', flags: { i: true } }],
  ['numeric flags', { pattern: 'ok', flags: 5 }],
];

describe('regex rules with a malformed config', () => {
  for (const type of ['regex_match', 'regex_no_match'] as const) {
    for (const [label, config] of brokenRegexConfigs) {
      it(`${type} with ${label} skips as configInvalid instead of throwing`, () => {
        const rule = createCustomRule({ name: 'x', type, config });
        let result;
        expect(() => {
          result = rule.evaluate({ output: 'anything' });
        }).not.toThrow();
        expect(result).toMatchObject({
          ruleName: 'x',
          passed: false,
          score: 0,
          skipped: true,
          configInvalid: true,
        });
        expect(result!.skipReason).toMatch(/config\.(pattern|flags)/);
      });
    }
  }

  it('still accepts a string pattern with string flags', () => {
    const rule = createCustomRule({ name: 'x', type: 'regex_match', config: { pattern: 'HELLO', flags: 'i' } });
    expect(rule.evaluate({ output: 'hello world' }).passed).toBe(true);
  });
});

describe('keyword rules with a malformed config', () => {
  for (const type of ['contains_keywords', 'excludes_keywords'] as const) {
    it(`${type} with non-string keywords skips as configInvalid instead of throwing`, () => {
      const rule = createCustomRule({ name: 'k', type, config: { keywords: [1, 2] } });
      let result;
      expect(() => {
        result = rule.evaluate({ output: 'anything' });
      }).not.toThrow();
      expect(result).toMatchObject({ skipped: true, configInvalid: true });
      expect(result!.skipReason).toContain('config.keywords');
    });
  }
});

describe('the engine survives an inline rule with a malformed config', () => {
  it('finishes the evaluation and reports the rule as skipped', () => {
    const engine = new EvalEngine(0.7);
    const broken: CustomRuleDefinition = { name: 'x', type: 'regex_match', config: {} };

    let result;
    expect(() => {
      result = engine.evaluate('custom', { output: 'anything' }, [broken]);
    }).not.toThrow();

    // The only rule skipped, so there is no verdict — insufficient_data,
    // not a crash, with the reason spelled out for the caller.
    expect(result!.insufficient_data).toBe(true);
    expect(result!.rules_skipped).toBe(1);
    expect(result!.rule_results[0]).toMatchObject({ ruleName: 'x', skipped: true, configInvalid: true });
    expect(result!.suggestions.join(' ')).toContain('config.pattern');
  });

  it('keeps scoring the rules that are well-formed', () => {
    const engine = new EvalEngine(0.7);
    const result = engine.evaluate('custom', { output: 'hello there world' }, [
      { name: 'broken', type: 'regex_match', config: { pattern: null } },
      { name: 'fine', type: 'contains_keywords', config: { keywords: ['hello'] } },
    ]);
    expect(result.insufficient_data).toBe(false);
    expect(result.rules_evaluated).toBe(1);
    expect(result.rules_skipped).toBe(1);
    expect(result.passed).toBe(true);
  });
});
