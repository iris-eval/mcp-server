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

const HALLUCINATION_MARKERS = [
  'as an ai',
  'as a language model',
  'i cannot',
  'i don\'t have access',
  'i apologize',
  'i\'m not able to',
  'i must clarify',
  'it\'s important to note that i',
  'i should mention that as',
  'i\'m just an ai',
  'i don\'t actually',
  'i cannot provide',
  'i\'m unable to',
  'please note that i',
  'as a digital assistant',
  'i want to be transparent',
  'i need to be honest',
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
      return { ruleName: 'topic_consistency', passed: false, score: 0, message: 'No input provided', skipped: true, skipReason: 'context.input not provided' };
    }
    const inputWords = context.input.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const outputWords = context.output.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    if (inputWords.length === 0 || outputWords.length === 0) {
      return { ruleName: 'topic_consistency', passed: false, score: 0, message: 'Insufficient text for topic analysis', skipped: true, skipReason: 'input or output has no words > 3 chars' };
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

export const relevanceRules: EvalRule[] = [keywordOverlap, noHallucinationMarkers, topicConsistency];
