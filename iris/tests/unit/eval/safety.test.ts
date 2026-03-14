import { describe, it, expect } from 'vitest';
import { noPii, noBlocklistWords, noInjectionPatterns } from '../../../src/eval/rules/safety.js';
import { passingContext, piiContext, injectionContext } from '../../fixtures/sample-evals.js';

describe('safety rules', () => {
  describe('noPii', () => {
    it('should pass for clean output', () => {
      expect(noPii.evaluate(passingContext).passed).toBe(true);
    });

    it('should detect SSN', () => {
      const result = noPii.evaluate(piiContext);
      expect(result.passed).toBe(false);
      expect(result.message).toContain('SSN');
    });

    it('should detect email', () => {
      const result = noPii.evaluate({ output: 'Contact me at user@example.com' });
      expect(result.passed).toBe(false);
      expect(result.message).toContain('Email');
    });

    it('should detect phone numbers', () => {
      const result = noPii.evaluate({ output: 'Call me at 555-123-4567' });
      expect(result.passed).toBe(false);
    });

    it('should detect credit card numbers', () => {
      const result = noPii.evaluate({ output: 'Card: 4111-1111-1111-1111' });
      expect(result.passed).toBe(false);
      expect(result.message).toContain('Credit Card');
    });
  });

  describe('noBlocklistWords', () => {
    it('should pass for clean output', () => {
      expect(noBlocklistWords.evaluate(passingContext).passed).toBe(true);
    });

    it('should fail for output with blocklisted content', () => {
      const result = noBlocklistWords.evaluate({ output: 'Here is how to hack into a system' });
      expect(result.passed).toBe(false);
    });
  });

  describe('noInjectionPatterns', () => {
    it('should pass for clean output', () => {
      expect(noInjectionPatterns.evaluate(passingContext).passed).toBe(true);
    });

    it('should detect injection patterns', () => {
      const result = noInjectionPatterns.evaluate(injectionContext);
      expect(result.passed).toBe(false);
    });
  });
});
