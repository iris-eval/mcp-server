import type { EvalRule, EvalContext, EvalRuleResult } from '../../types/eval.js';

export const keywordOverlap: EvalRule = {
  name: 'keyword_overlap',
  description: 'Measures word overlap between input and output',
  evalType: 'relevance',
  weight: 1,
  evaluate(context: EvalContext): EvalRuleResult {
    if (!context.input) {
      return { ruleName: 'keyword_overlap', passed: false, score: 0, message: 'No input provided', skipped: true, skipReason: 'context.input not provided' };
    }
    const inputWords = new Set(
      context.input.toLowerCase().split(/\W+/).filter((w) => w.length > 2),
    );
    const outputWords = new Set(
      context.output.toLowerCase().split(/\W+/).filter((w) => w.length > 2),
    );
    if (inputWords.size === 0) {
      return { ruleName: 'keyword_overlap', passed: true, score: 1, message: 'No meaningful words in input' };
    }
    let overlap = 0;
    for (const word of inputWords) {
      if (outputWords.has(word)) overlap++;
    }
    const ratio = overlap / inputWords.size;
    const threshold = (context.customConfig?.keyword_overlap as number) ?? 0.35;
    const passed = ratio >= threshold;
    return {
      ruleName: 'keyword_overlap',
      passed,
      score: Math.min(ratio * 2, 1),
      message: `${overlap}/${inputWords.size} input keywords found in output (${(ratio * 100).toFixed(0)}%)`,
    };
  },
};

/*
 * no_hallucination_markers moved to the safety bundle (safety.ts) in
 * v0.4.7 — its rewrite is context-grounded fabrication/contradiction
 * detection, and the safety bundle is where the evaluate_output docs,
 * the dashboard's safety-violations panel, and the storage adapter's
 * violation counts have always placed it.
 */

export const topicConsistency: EvalRule = {
  name: 'topic_consistency',
  description: 'Output stays on topic relative to input (skipped when output too brief for meaningful comparison)',
  evalType: 'relevance',
  weight: 1,
  evaluate(context: EvalContext): EvalRuleResult {
    if (!context.input) {
      return { ruleName: 'topic_consistency', passed: false, score: 0, message: 'No input provided', skipped: true, skipReason: 'context.input not provided' };
    }
    const inputWords = context.input.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const outputWords = context.output.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    if (inputWords.length === 0 || outputWords.length === 0) {
      return { ruleName: 'topic_consistency', passed: false, score: 0, message: 'Insufficient text for topic analysis', skipped: true, skipReason: 'input or output has no words > 3 chars' };
    }
    // v0.3.1 fix: skip when output is too brief — short outputs (1-5 words >3 chars)
    // produce noisy ratios where the threshold can't meaningfully discriminate.
    // The previous version over-triggered as a false-positive on brief but valid responses.
    const minOutputWords = (context.customConfig?.topic_consistency_min_words as number) ?? 6;
    if (outputWords.length < minOutputWords) {
      return {
        ruleName: 'topic_consistency',
        passed: true, // benefit of the doubt for brief outputs
        score: 1,
        message: `Output too brief for meaningful topic analysis (${outputWords.length} words ≥ 4 chars; min ${minOutputWords})`,
        skipped: true,
        skipReason: `output has < ${minOutputWords} words ≥ 4 chars`,
      };
    }
    const inputSet = new Set(inputWords);
    let relevant = 0;
    for (const word of outputWords) {
      if (inputSet.has(word)) relevant++;
    }
    const ratio = relevant / outputWords.length;
    const threshold = (context.customConfig?.topic_consistency as number) ?? 0.10;
    const passed = ratio >= threshold;
    return {
      ruleName: 'topic_consistency',
      passed,
      score: Math.min(ratio * 5, 1),
      message: `Topic consistency: ${(ratio * 100).toFixed(1)}% of output words relate to input`,
    };
  },
};

export const relevanceRules: EvalRule[] = [keywordOverlap, topicConsistency];
