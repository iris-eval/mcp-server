import { describe, it, expect } from 'vitest';
import { costUnderThreshold, tokenEfficiency } from '../../../src/eval/rules/cost.js';
import { passingContext, expensiveContext } from '../../fixtures/sample-evals.js';

describe('cost rules', () => {
  describe('costUnderThreshold', () => {
    it('should pass for low cost', () => {
      expect(costUnderThreshold.evaluate(passingContext).passed).toBe(true);
    });

    it('should fail for expensive output', () => {
      expect(costUnderThreshold.evaluate(expensiveContext).passed).toBe(false);
    });

    it('should skip when no cost info', () => {
      const result = costUnderThreshold.evaluate({ output: 'test' });
      expect(result.skipped).toBe(true);
      expect(result.passed).toBe(false);
    });
  });

  describe('tokenEfficiency', () => {
    it('should pass for efficient token usage', () => {
      expect(tokenEfficiency.evaluate(passingContext).passed).toBe(true);
    });

    it('should fail for inefficient token usage', () => {
      const result = tokenEfficiency.evaluate({
        output: 'test',
        tokenUsage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 },
      });
      expect(result.passed).toBe(false);
    });

    it('should skip when no token usage', () => {
      const result = tokenEfficiency.evaluate({ output: 'test' });
      expect(result.skipped).toBe(true);
      expect(result.passed).toBe(false);
    });
  });
});
