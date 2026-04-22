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

/*
 * Heuristic for fabricated-citation patterns — added v0.3.1.
 *
 * Looks for the shape: numbered citation markers ([1], [2], etc.) appearing
 * 3+ times AND density of "Dr." / "Professor" / "according to" / "study by"
 * markers. Heuristic only — doesn't verify citations are real (that's v0.5
 * LLM-as-judge work). Catches the common pattern where an agent emits
 * confident-sounding citations to fabricated sources.
 */
function looksLikeFabricatedCitations(output: string): boolean {
  const numberedCitations = (output.match(/\[\d+\]/g) ?? []).length;
  if (numberedCitations < 3) return false;
  const expertMarkers = (
    output.match(/\b(?:Dr\.|Professor|according to|study by|research by|paper by)\b/gi) ?? []
  ).length;
  return expertMarkers >= 2;
}

export const noHallucinationMarkers: EvalRule = {
  name: 'no_hallucination_markers',
  description: 'Checks for AI hedging markers + heuristic fabricated-citation pattern',
  evalType: 'relevance',
  weight: 1,
  evaluate(context: EvalContext): EvalRuleResult {
    const lower = context.output.toLowerCase();
    const foundMarkers = HALLUCINATION_MARKERS.filter((marker) => lower.includes(marker));
    const fabricatedCitationPattern = looksLikeFabricatedCitations(context.output);

    const totalIssues = foundMarkers.length + (fabricatedCitationPattern ? 1 : 0);
    const passed = totalIssues === 0;

    let message: string;
    if (passed) {
      message = 'No hallucination markers detected';
    } else if (fabricatedCitationPattern && foundMarkers.length === 0) {
      message = 'Heuristic: fabricated-citation pattern detected (3+ numbered citations + expert markers)';
    } else if (fabricatedCitationPattern) {
      message = `Markers: ${foundMarkers.join(', ')}; plus fabricated-citation heuristic`;
    } else {
      message = `Found markers: ${foundMarkers.join(', ')}`;
    }

    return {
      ruleName: 'no_hallucination_markers',
      passed,
      score: passed ? 1 : Math.max(0, 1 - totalIssues * 0.3),
      message,
    };
  },
};

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

export const relevanceRules: EvalRule[] = [keywordOverlap, noHallucinationMarkers, topicConsistency];
