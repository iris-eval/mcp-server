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
      config: { pattern: '(a+)+$' },
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
      config: { pattern: '(a+)+$' },
    });
    const result = rule.evaluate({ output: 'test' });
    expect(result.passed).toBe(false);
    expect(result.message).toContain('unsafe');
  });
});
