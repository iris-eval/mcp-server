import { describe, it, expect } from 'vitest';
import { keywordOverlap, topicConsistency } from '../../../src/eval/rules/relevance.js';
import { passingContext } from '../../fixtures/sample-evals.js';

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

  // no_hallucination_markers moved to the safety bundle (v0.5.0) —
  // its tests live in tests/unit/eval/safety.test.ts.

  describe('topicConsistency', () => {
    it('should pass when output is on-topic', () => {
      expect(topicConsistency.evaluate(passingContext).passed).toBe(true);
    });

    it('should skip when no input', () => {
      const result = topicConsistency.evaluate({ output: 'Some text' });
      expect(result.skipped).toBe(true);
      expect(result.passed).toBe(false);
    });

    // v0.3.1 fix: brief outputs should skip rather than over-trigger
    it('should skip when output is too brief for meaningful topic analysis', () => {
      const result = topicConsistency.evaluate({
        input: 'Tell me about quantum computing and its applications in cryptography',
        output: 'Yes, certainly.', // 2 words ≥ 4 chars
      });
      expect(result.skipped).toBe(true);
      expect(result.passed).toBe(true); // benefit-of-the-doubt for brief outputs
    });

    it('should respect custom topic_consistency_min_words config', () => {
      const result = topicConsistency.evaluate({
        input: 'Tell me about quantum computing and cryptography',
        output: 'Quantum computing supports cryptographic operations.', // 4 words ≥ 4 chars
        customConfig: { topic_consistency_min_words: 10 },
      });
      expect(result.skipped).toBe(true);
    });
  });
});
