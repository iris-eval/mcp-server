import type { EvalRule, EvalContext, EvalRuleResult } from '../../types/eval.js';

export const minOutputLength: EvalRule = {
  name: 'min_output_length',
  description: 'Output must meet a minimum character length',
  evalType: 'completeness',
  weight: 1,
  evaluate(context: EvalContext): EvalRuleResult {
    const minLen = (context.customConfig?.min_output_length as number)
      ?? (context.customConfig?.min_length as number)
      ?? 50;
    const len = context.output.length;
    const passed = len >= minLen;
    return {
      ruleName: 'min_output_length',
      passed,
      score: passed ? 1 : Math.min(len / minLen, 0.99),
      message: passed ? `Output length (${len}) meets minimum (${minLen})` : `Output length (${len}) below minimum (${minLen})`,
    };
  },
};

export const nonEmptyOutput: EvalRule = {
  name: 'non_empty_output',
  description: 'Output must not be empty or whitespace-only',
  evalType: 'completeness',
  weight: 2,
  evaluate(context: EvalContext): EvalRuleResult {
    const passed = context.output.trim().length > 0;
    return {
      ruleName: 'non_empty_output',
      passed,
      score: passed ? 1 : 0,
      message: passed ? 'Output is non-empty' : 'Output is empty or whitespace-only',
    };
  },
};

export const sentenceCount: EvalRule = {
  name: 'sentence_count',
  description: 'Output must contain a minimum number of sentences',
  evalType: 'completeness',
  weight: 0.5,
  evaluate(context: EvalContext): EvalRuleResult {
    const minSentences = (context.customConfig?.min_sentences as number) ?? 2;
    const sentences = context.output.split(/[.!?]+/).filter((s) => s.trim().length > 0).length;
    const passed = sentences >= minSentences;
    return {
      ruleName: 'sentence_count',
      passed,
      score: passed ? 1 : Math.min(sentences / minSentences, 0.99),
      message: passed ? `Sentence count (${sentences}) meets minimum (${minSentences})` : `Sentence count (${sentences}) below minimum (${minSentences})`,
    };
  },
};

export const expectedCoverage: EvalRule = {
  name: 'expected_coverage',
  description: 'Output must cover key terms from expected output',
  evalType: 'completeness',
  weight: 1.5,
  evaluate(context: EvalContext): EvalRuleResult {
    if (!context.expected) {
      return { ruleName: 'expected_coverage', passed: false, score: 0, message: 'No expected output provided', skipped: true, skipReason: 'context.expected not provided' };
    }
    const expectedWords = new Set(
      context.expected.toLowerCase().split(/\W+/).filter((w) => w.length > 2),
    );
    const outputWords = new Set(
      context.output.toLowerCase().split(/\W+/).filter((w) => w.length > 2),
    );
    if (expectedWords.size === 0) {
      return { ruleName: 'expected_coverage', passed: true, score: 1, message: 'No meaningful words in expected output' };
    }
    let covered = 0;
    for (const word of expectedWords) {
      if (outputWords.has(word)) covered++;
    }
    const ratio = covered / expectedWords.size;
    const passed = ratio >= 0.5;
    return {
      ruleName: 'expected_coverage',
      passed,
      score: ratio,
      message: `Covered ${covered}/${expectedWords.size} expected terms (${(ratio * 100).toFixed(0)}%)`,
    };
  },
};

export const completenessRules: EvalRule[] = [minOutputLength, nonEmptyOutput, sentenceCount, expectedCoverage];
