import { describe, it, expect } from 'vitest';
import { createCustomRule } from '../../../src/eval/rules/custom.js';

describe('custom regex safety', () => {
  it('should allow safe regex patterns', () => {
    const rule = createCustomRule({
      name: 'test',
      type: 'regex_match',
      config: { pattern: 'hello\\s+world' },
    });
    const result = rule.evaluate({ output: 'hello world' });
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  it('should reject ReDoS patterns', () => {
    const rule = createCustomRule({
      name: 'test',
      type: 'regex_match',
      // lgtm[js/redos] — intentionally testing ReDoS detection
      config: { pattern: '(a+)+$' }, // codeql-suppress js/redos
    });
    const result = rule.evaluate({ output: 'aaaaaaaaaaaaaaa!' });
    expect(result.passed).toBe(false);
    expect(result.message).toContain('unsafe');
  });

  it('should reject overlength patterns', () => {
    const rule = createCustomRule({
      name: 'test',
      type: 'regex_match',
      config: { pattern: 'a'.repeat(1001) },
    });
    const result = rule.evaluate({ output: 'test' });
    expect(result.passed).toBe(false);
    expect(result.message).toContain('too long');
  });

  it('should handle unsafe or invalid regex patterns gracefully', () => {
    const rule = createCustomRule({
      name: 'test',
      type: 'regex_match',
      config: { pattern: '[invalid' },
    });
    const result = rule.evaluate({ output: 'test' });
    expect(result.passed).toBe(false);
    // Pattern may be caught by safe-regex or by RegExp constructor
    expect(result.score).toBe(0);
  });

  it('should work with regex_no_match and safe patterns', () => {
    const rule = createCustomRule({
      name: 'test',
      type: 'regex_no_match',
      config: { pattern: 'forbidden' },
    });
    const result = rule.evaluate({ output: 'clean output' });
    expect(result.passed).toBe(true);
  });

  it('should reject ReDoS in regex_no_match too', () => {
    const rule = createCustomRule({
      name: 'test',
      type: 'regex_no_match',
      // lgtm[js/redos] — intentionally testing ReDoS detection
      config: { pattern: '(a+)+$' }, // codeql-suppress js/redos
    });
    const result = rule.evaluate({ output: 'test' });
    expect(result.passed).toBe(false);
    expect(result.message).toContain('unsafe');
  });

  /*
   * Patterns that pass EVERY static check and still backtrack superlinearly.
   * These are the persona-UAT blocker class: safe-regex2 is star-height-only
   * (`(a|a)*$` has star height 1 → judged safe), and no probe can guess an
   * igniting payload in general. The sandbox deadline is the only guard that
   * holds — each of these must come back as a SKIP within the budget, never
   * hang the process.
   */
  describe('statically-invisible ReDoS (sandbox deadline is the boundary)', () => {
    // lgtm[js/redos] — intentionally hostile test inputs
    const cases: Array<{ pattern: string; fuel: string }> = [
      { pattern: '^(a|a)*$', fuel: 'a'.repeat(40) + 'b' }, // exponential, 2^40 steps
      { pattern: '.*.*.*.*=.*', fuel: 'a'.repeat(20_000) }, // polynomial, no '=' anywhere
    ];

    for (const { pattern, fuel } of cases) {
      it(`kills ${pattern} at the budget and reports a skip`, () => {
        const rule = createCustomRule({
          name: 'hostile',
          type: 'regex_match',
          config: { pattern }, // codeql-suppress js/redos
        });
        const started = Date.now();
        const result = rule.evaluate({ output: fuel });
        expect(Date.now() - started).toBeLessThan(2000);
        expect(result.skipped).toBe(true);
        expect(result.passed).toBe(false);
        expect(result.score).toBe(0);
        expect(result.message).toContain('matching budget');
      });
    }

    it('kills hostile patterns in regex_no_match the same way', () => {
      const rule = createCustomRule({
        name: 'hostile-no-match',
        type: 'regex_no_match',
        config: { pattern: '^(a|a)*$' }, // codeql-suppress js/redos
      });
      const started = Date.now();
      const result = rule.evaluate({ output: 'a'.repeat(40) + 'b' });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(result.skipped).toBe(true);
      expect(result.message).toContain('matching budget');
    });

    it('a budget skip carries budgetExceeded so consumers can fail closed', () => {
      const rule = createCustomRule({
        name: 'policy',
        type: 'regex_no_match',
        config: { pattern: '^(a|a)*$' }, // codeql-suppress js/redos
      });
      const result = rule.evaluate({ output: 'a'.repeat(40) + 'b' });
      expect(result.skipped).toBe(true);
      expect(result.budgetExceeded).toBe(true);
      // The distinct flag is the whole point: an output CRAFTED to stall a
      // policy pattern must be distinguishable from a missing-context skip.
      expect(result.message).toContain('fail closed');
    });

    it('a budget skip is NOT configInvalid — it depends on the input', () => {
      const rule = createCustomRule({
        name: 'hostile',
        type: 'regex_match',
        config: { pattern: '^(a|a)*$' }, // codeql-suppress js/redos
      });
      // Benign input: same pattern completes instantly and judges normally.
      const benign = rule.evaluate({ output: 'aaaa' });
      expect(benign.skipped).toBeUndefined();
      expect(benign.passed).toBe(true);
      // Hostile input: skip, but without the configInvalid marker that would
      // make the preview endpoint 422 the definition itself.
      const hostile = rule.evaluate({ output: 'a'.repeat(40) + 'b' });
      expect(hostile.skipped).toBe(true);
      expect(hostile.configInvalid).toBeUndefined();
    });
  });
});
