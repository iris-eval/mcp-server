import type { EvalRule, EvalContext, EvalRuleResult } from '../../types/eval.js';

export const keywordOverlap: EvalRule = {
  name: 'keyword_overlap',
  description: 'Measures word overlap between input and output',
  evalType: 'relevance',
  weight: 1,
  evaluate(context: EvalContext): EvalRuleResult {
    if (!context.input) {
      return { ruleName: 'keyword_overlap', passed: true, score: 1, message: 'No input provided — skipped' };
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
    const passed = ratio >= 0.2;
    return {
      ruleName: 'keyword_overlap',
      passed,
      score: Math.min(ratio * 2, 1),
      message: `${overlap}/${inputWords.size} input keywords found in output (${(ratio * 100).toFixed(0)}%)`,
    };
  },
};

const HALLUCINATION_MARKERS = [
  'as an ai',
  'i cannot',
  'i don\'t have access',
  'i apologize',
  'i\'m not able to',
  'i must clarify',
  'it\'s important to note that i',
  'i should mention that as',
];

export const noHallucinationMarkers: EvalRule = {
  name: 'no_hallucination_markers',
  description: 'Checks for common AI hedging/hallucination markers',
  evalType: 'relevance',
  weight: 1,
  evaluate(context: EvalContext): EvalRuleResult {
    const lower = context.output.toLowerCase();
    const found = HALLUCINATION_MARKERS.filter((marker) => lower.includes(marker));
    const passed = found.length === 0;
    return {
      ruleName: 'no_hallucination_markers',
      passed,
      score: passed ? 1 : Math.max(0, 1 - found.length * 0.3),
      message: passed ? 'No hallucination markers detected' : `Found markers: ${found.join(', ')}`,
    };
  },
};

export const topicConsistency: EvalRule = {
  name: 'topic_consistency',
  description: 'Output stays on topic relative to input',
  evalType: 'relevance',
  weight: 1,
  evaluate(context: EvalContext): EvalRuleResult {
    if (!context.input) {
      return { ruleName: 'topic_consistency', passed: true, score: 1, message: 'No input provided — skipped' };
    }
    const inputWords = context.input.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const outputWords = context.output.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    if (inputWords.length === 0 || outputWords.length === 0) {
      return { ruleName: 'topic_consistency', passed: true, score: 1, message: 'Insufficient text for topic analysis' };
    }
    const inputSet = new Set(inputWords);
    let relevant = 0;
    for (const word of outputWords) {
      if (inputSet.has(word)) relevant++;
    }
    const ratio = relevant / outputWords.length;
    const passed = ratio >= 0.05;
    return {
      ruleName: 'topic_consistency',
      passed,
      score: Math.min(ratio * 5, 1),
      message: `Topic consistency: ${(ratio * 100).toFixed(1)}% of output words relate to input`,
    };
  },
};

export const relevanceRules: EvalRule[] = [keywordOverlap, noHallucinationMarkers, topicConsistency];
