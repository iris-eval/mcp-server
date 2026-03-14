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
      expect(result.passed).toBe(true);
      expect(result.score).toBe(1);
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
      expect(topicConsistency.evaluate({ output: 'Some text' }).passed).toBe(true);
    });
  });
});
