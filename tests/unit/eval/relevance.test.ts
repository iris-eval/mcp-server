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

    // v0.3.1 fabricated-citation heuristic
    it('should detect fabricated citation pattern (3+ numbered citations + expert markers)', () => {
      const result = noHallucinationMarkers.evaluate({
        output:
          'According to Dr. Smith [1], market grew 87% [2]. Study by Professor Jones found similar trends [3]. Per analyst report [4].',
      });
      expect(result.passed).toBe(false);
      expect(result.message).toContain('fabricated-citation');
    });

    it('should not flag legitimate single citation as fabricated', () => {
      const result = noHallucinationMarkers.evaluate({
        output: 'According to the research paper [1], the result was reproducible.',
      });
      expect(result.passed).toBe(true);
    });

    it('should not flag numbered list without expert markers as fabricated', () => {
      const result = noHallucinationMarkers.evaluate({
        output: 'Steps: [1] Install. [2] Configure. [3] Run. [4] Verify.',
      });
      expect(result.passed).toBe(true);
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
