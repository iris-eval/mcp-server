import { describe, it, expect } from 'vitest';
import { keywordOverlap, noHallucinationMarkers, topicConsistency } from '../../../src/eval/rules/relevance.js';
import { passingContext, hallucinatingContext } from '../../fixtures/sample-evals.js';

describe('relevance rules', () => {
  describe('keywordOverlap', () => {
    it('should pass when output shares keywords with input', () => {
      const result = keywordOverlap.evaluate(passingContext);
      expect(result.passed).toBe(true);
    });

    it('should skip when no input provided', () => {
      const result = keywordOverlap.evaluate({ output: 'Some output' });
      expect(result.skipped).toBe(true);
      expect(result.passed).toBe(false);
      expect(result.score).toBe(0);
    });
  });

  describe('noHallucinationMarkers', () => {
    it('should pass for clean output', () => {
      expect(noHallucinationMarkers.evaluate(passingContext).passed).toBe(true);
    });

    it('should fail for output with hallucination markers', () => {
      const result = noHallucinationMarkers.evaluate(hallucinatingContext);
      expect(result.passed).toBe(false);
    });
  });

  describe('topicConsistency', () => {
    it('should pass when output is on-topic', () => {
      expect(topicConsistency.evaluate(passingContext).passed).toBe(true);
    });

    it('should skip when no input', () => {
      const result = topicConsistency.evaluate({ output: 'Some text' });
      expect(result.skipped).toBe(true);
      expect(result.passed).toBe(false);
    });
  });
});
