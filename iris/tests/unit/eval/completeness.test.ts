import { describe, it, expect } from 'vitest';
import { minOutputLength, nonEmptyOutput, sentenceCount, expectedCoverage } from '../../../src/eval/rules/completeness.js';
import { passingContext, failingContext, shortOutputContext } from '../../fixtures/sample-evals.js';

describe('completeness rules', () => {
  describe('minOutputLength', () => {
    it('should pass for output above minimum', () => {
      const result = minOutputLength.evaluate(passingContext);
      expect(result.passed).toBe(true);
      expect(result.score).toBe(1);
    });

    it('should fail for very short output', () => {
      const result = minOutputLength.evaluate(shortOutputContext);
      expect(result.passed).toBe(false);
      expect(result.score).toBeLessThan(1);
    });
  });

  describe('nonEmptyOutput', () => {
    it('should pass for non-empty output', () => {
      expect(nonEmptyOutput.evaluate(passingContext).passed).toBe(true);
    });

    it('should fail for empty output', () => {
      expect(nonEmptyOutput.evaluate(failingContext).passed).toBe(false);
    });

    it('should fail for whitespace-only output', () => {
      expect(nonEmptyOutput.evaluate({ output: '   \n\t  ' }).passed).toBe(false);
    });
  });

  describe('sentenceCount', () => {
    it('should pass for multi-sentence output', () => {
      expect(sentenceCount.evaluate(passingContext).passed).toBe(true);
    });

    it('should handle output with no sentences', () => {
      expect(sentenceCount.evaluate(failingContext).passed).toBe(false);
    });
  });

  describe('expectedCoverage', () => {
    it('should pass when output covers expected terms', () => {
      const result = expectedCoverage.evaluate(passingContext);
      expect(result.passed).toBe(true);
      expect(result.score).toBeGreaterThan(0);
    });

    it('should skip when no expected output', () => {
      const result = expectedCoverage.evaluate({ output: 'Hello world' });
      expect(result.passed).toBe(true);
      expect(result.score).toBe(1);
    });

    it('should fail when output misses expected terms', () => {
      const result = expectedCoverage.evaluate({
        output: 'Completely unrelated response about cooking',
        expected: 'Quantum physics explanation with equations',
      });
      expect(result.score).toBeLessThan(0.5);
    });
  });
});
