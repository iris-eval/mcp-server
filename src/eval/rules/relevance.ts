import type { EvalRule, EvalContext, EvalRuleResult } from '../../types/eval.js';
import { sentencesOf } from '../text/sentences.js';

/*
 * Relevance rules — one tokenizer, two DISTINCT signals.
 *
 * Redesigned after an acceptance pass ran twenty-four transcripts
 * produced by an agent genuinely working against this repository
 * (tests/fixtures/real-transcripts/). Three grounded, correct technical
 * answers — what `--purge` does, what `eval_type: "all"` returns, a
 * one-paragraph product description — failed topic_consistency at
 * 6.7% / 3.6% / 2.0%. The old measure was the fraction of OUTPUT words that
 * also appear in the INPUT, which punishes precisely what a good technical
 * answer does: bring the source's vocabulary (identifiers, file names,
 * exact values, mechanism) to a short question that did not contain it.
 * The failure was structural — no threshold rescues a measure that reads
 * new, correct vocabulary as drift — so the measure changed, not the number.
 *
 *   keyword_overlap   RECALL. What share of the ask's content terms does the
 *                     output engage at all? Fails a refusal, a different
 *                     product, filler, an answer that never touches the
 *                     subject.
 *   topic_consistency CONTINUITY. What share of the output's content-
 *                     bearing sentences connect to the ask — directly, or
 *                     through an earlier connected sentence? Fails an answer
 *                     that opens on topic and wanders, and everything
 *                     keyword_overlap fails. Grounded answers chain their
 *                     vocabulary back to the ask; a ramble does not.
 *
 * Both rules share the tokenizer below, so they agree on what a "term" is
 * and no longer double-count one measurement:
 *   - stopwords (articles, pronouns, auxiliaries, question words, the
 *     request verbs — "explain", "summarise", "tell me" — and the form of
 *     the deliverable — "paragraph", "bullets", "summary") are not terms;
 *   - code identifiers, paths and flags are SPLIT into their words
 *     (`EvalEngine.evaluateAll()` → eval, engine, evaluate; `src/index.ts`
 *     → src, index) rather than dropped: the words inside an identifier
 *     ARE topic vocabulary, and dropping them was half of the old failure;
 *   - numbers and fenced code blocks are neutral (neither for nor against);
 *   - a light stemmer folds inflections (purge/purged/purging, rule/rules,
 *     evaluate/evaluation/evaluator) so the same word in a different form
 *     still counts. It is deliberately crude — both sides get the same
 *     treatment, so an imperfect stem only lowers sensitivity, never
 *     invents a match.
 *
 * Honest limits (lexical, no model): an answer that paraphrases the ask
 * with none of its words reads as off topic; a coherent essay on the wrong
 * subject that happens to reuse one of the ask's words reads as on topic.
 * Semantic relevance is the LLM judge's job (evaluate_with_llm_judge,
 * `relevance` template).
 */

import { FENCED_CODE, contentTerms, stemTerm } from '../terms.js';
import { thresholdSourceOf } from '../thresholds.js';
import { toolChoice } from './tool-choice.js';
// The tokenizer lives in src/eval/terms.ts; re-exported so nothing that imported it from here moves.
export { contentTerms, stemTerm };

export const keywordOverlap: EvalRule = {
  name: 'keyword_overlap',
  description:
    'Recall of the input\'s content terms in the output: stopwords and request verbs are not terms, code identifiers and paths are split into their words, inflections are folded (purge/purged/purging). Passes when at least 35% of the input\'s terms appear in the output (configurable: keyword_overlap)',
  evalType: 'relevance',
  weight: 1,
  kind: 'measurement',
  mechanism: 'formula',
  needs: ['output', 'input'],
  question: 'relevant',
  classes: ['off_task'],
  version: 1,
  evaluate(context: EvalContext): EvalRuleResult {
    if (!context.input) {
      return { ruleName: 'keyword_overlap', passed: false, score: 0, message: 'No input provided', skipped: true, skipReason: 'context.input not provided' };
    }
    const inputTerms = new Set(contentTerms(context.input));
    if (inputTerms.size === 0) {
      return { ruleName: 'keyword_overlap', passed: true, score: 1, message: 'No meaningful words in input' };
    }
    const outputTerms = new Set(contentTerms(context.output));
    let overlap = 0;
    for (const term of inputTerms) {
      if (outputTerms.has(term)) overlap++;
    }
    const ratio = overlap / inputTerms.size;
    const threshold = (context.customConfig?.keyword_overlap as number) ?? 0.35;
    const passed = ratio >= threshold;
    return {
      value: { stat: 'input_terms_in_output', unit: 'ratio', value: ratio },
      evidence: [{ type: 'count', stat: 'input_terms_in_output', unit: 'ratio', value: ratio, threshold, thresholdSource: thresholdSourceOf(context, 'keyword_overlap') }],
      ruleName: 'keyword_overlap',
      passed,
      score: Math.min(ratio * 2, 1),
      message: `${overlap}/${inputTerms.size} input keywords found in output (${(ratio * 100).toFixed(0)}%)`,
    };
  },
};

/*
 * no_hallucination_markers moved to the safety bundle (safety.ts) in
 * v0.5.0 — its rewrite is context-grounded fabrication/contradiction
 * detection, and the safety bundle is where the evaluate_output docs,
 * the dashboard's safety-violations panel, and the storage adapter's
 * violation counts have always placed it.
 */

/**
 * A third of the content-bearing sentences must connect. Why a third and
 * not half: the measure is a floor against drift, not a target — grounded
 * answers in the real-transcript set connect 67–100% of their sentences —
 * and the false positive that matters is the SHORT honest answer whose
 * second and third sentences elaborate in fresh words ("It is sunny today.
 * Expect a high of 75°F. Bring sunglasses."). At a half that answer fails;
 * at a third it passes while "one on-topic sentence, then three about
 * something else" (25%) still fails.
 */
const DEFAULT_TOPIC_THRESHOLD = 1 / 3;

const LIST_ITEM = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/;
/*
 * Replaced by the shared splitter (src/eval/text/sentences.ts). The old
 * pattern broke after any terminator followed by whitespace, so "Dr. Chen"
 * and "3. 5" were two sentences each.
 */

export const topicConsistency: EvalRule = {
  name: 'topic_consistency',
  description:
    'Continuity with the input: the share of the output\'s content-bearing sentences that connect to the input\'s topic — a sentence connects when it shares a content term with the input or with an earlier connected sentence (list items are read under the sentence that introduces them). Passes when at least a third connect (configurable: topic_consistency); a third, not half, so a short honest answer that elaborates in fresh words is not read as drift. Replaces the output-word-ratio measure that failed every grounded technical answer. Skipped when the output is too brief for meaningful comparison',
  evalType: 'relevance',
  weight: 1,
  kind: 'measurement',
  mechanism: 'formula',
  needs: ['output', 'input'],
  question: 'relevant',
  classes: ['off_task'],
  version: 1,
  evaluate(context: EvalContext): EvalRuleResult {
    if (!context.input) {
      return { ruleName: 'topic_consistency', passed: false, score: 0, message: 'No input provided', skipped: true, skipReason: 'context.input not provided' };
    }
    const inputWords = context.input.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const outputWords = context.output.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    if (inputWords.length === 0 || outputWords.length === 0) {
      return { ruleName: 'topic_consistency', passed: false, score: 0, message: 'Insufficient text for topic analysis', skipped: true, skipReason: 'input or output has no words > 3 chars' };
    }
    // v0.3.1: skip when the output is too brief — a handful of words cannot
    // be judged on topic or off it, and the rule used to cry wolf there.
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
    const topic = new Set(contentTerms(context.input));
    if (topic.size === 0) {
      return { ruleName: 'topic_consistency', passed: false, score: 0, message: 'Insufficient text for topic analysis', skipped: true, skipReason: 'input has no content terms' };
    }

    // Walk the output line by line so list items can be read under their
    // lead-in, and sentence by sentence within a line. `seen` is the topic
    // so far: the input's terms plus every connected sentence's terms.
    const seen = new Set(topic);
    let sentences = 0;
    let connected = 0;
    let leadInConnected = false;
    for (const line of context.output.replace(FENCED_CODE, '\n').split('\n')) {
      const isItem = LIST_ITEM.test(line);
      let lineConnected = false;
      for (const sentence of sentencesOf(line)) {
        const terms = contentTerms(sentence);
        if (terms.length === 0) continue;
        sentences++;
        const hit = terms.some((t) => seen.has(t)) || (isItem && leadInConnected);
        if (hit) {
          connected++;
          lineConnected = true;
          for (const t of terms) seen.add(t);
        }
      }
      if (!isItem && line.trim().length > 0) leadInConnected = lineConnected;
    }
    if (sentences === 0) {
      return { ruleName: 'topic_consistency', passed: false, score: 0, message: 'Insufficient text for topic analysis', skipped: true, skipReason: 'output has no content terms' };
    }
    const ratio = connected / sentences;
    const threshold = (context.customConfig?.topic_consistency as number) ?? DEFAULT_TOPIC_THRESHOLD;
    const passed = ratio >= threshold;
    return {
      ruleName: 'topic_consistency',
      passed,
      // Full marks at two thirds connected; proportional below.
      score: Math.min(ratio * 1.5, 1),
      value: { stat: 'connected_sentences', unit: 'ratio', value: ratio },
      /*
       * Where the threshold came from, never its value. The shipped config
       * carries topic_consistency 0.33, not this file's 1/3, so a value test
       * read every server's default as a deployment's setting, and
       * answers_the_ask (which reads this stamp) gated at the shipped config
       * from 0.18.0 while its notes said it advised.
       */
      evidence: [{ type: 'count', stat: 'connected_sentences', unit: 'ratio', value: ratio, threshold, thresholdSource: thresholdSourceOf(context, 'topic_consistency') }],
      message: `Topic consistency: ${connected}/${sentences} content sentences connect to the input's topic (${(ratio * 100).toFixed(0)}%)`,
    };
  },
};

/*
 * answers_the_ask — the composer question, answered with a
 * measurement. A truncated or off-topic answer used to read `clean`: the
 * two relevance rules are measurements, which inform the score, and only
 * policies and detections gate. Measured on the 141-case composite corpus
 * before this rule existed: gating on BOTH measurements failing together
 * flipped none of the classless clean cases, caught four of the eight
 * off-task cases (the other four: two too short to measure, two that reuse
 * the ask's words while ignoring it) and six stub cases the composer
 * missed. So the pair decides: when the input is present and both
 * keyword_overlap and topic_consistency fail at their thresholds (each
 * rule's own, config-aware), the output answers something else. A POLICY
 * with no number of its own — "both measurements failed" is structural —
 * so it gates on every call, at the shipped defaults too, and the two
 * measurements keep scoring. Not a critical detection: a critical rule that
 * skips on every output-only call would stamp critical_skipped on the
 * product's most common call shape. It skips whenever either measurement
 * skipped (no input, an output too brief for the topic measure) and on an
 * ask with fewer than two content terms, so a one-word right answer is
 * never a fire.
 */
/** An ask with one content term ("Is the server up?") cannot be judged lexically: the answer need not repeat its one word. */
export const MIN_ASK_TERMS_TO_JUDGE = 2;

/*
 * Two non-answers the lexical pair cannot see (2026-09-23 review).
 * "I cannot help with that." is too short for topic_consistency, so the pair
 * skipped and the verdict read clean; the ask copied back reuses every one of
 * the ask's words, so keyword_overlap passed it. Both are judged directly,
 * before the brevity skip, and only when there is an ask to compare with.
 */
const REFUSAL = /^\s*(?:(?:i['’]?m|i am)\s+(?:sorry|afraid|unable|not able)|i\s+(?:can(?:no|['’])t|won['’]?t|will not|do not|don['’]?t)\s+(?:help|assist|answer|do|provide|share)|sorry[,.!]?\s*(?:but\s+)?(?:i|no\b)|no[.!]?\s*$|unable to (?:help|assist|answer))/i;
/** At most this many words for an output to read as a bare refusal; a longer one that declines and then helps is judged on its content. */
const REFUSAL_MAX_WORDS = 25;

function isRefusal(output: string): boolean {
  return REFUSAL.test(output) && output.trim().split(/\s+/).length <= REFUSAL_MAX_WORDS;
}

/** The ask handed back: every content term of the output comes from the ask, and the output is no longer than the ask by more than a fifth. */
function isEcho(output: string, ask: string): boolean {
  const out = contentTerms(output);
  if (out.length === 0) return false;
  const askTerms = new Set(contentTerms(ask));
  return out.every((t) => askTerms.has(t)) && output.trim().length <= ask.trim().length * 1.2;
}

export const answersTheAsk: EvalRule = {
  name: 'answers_the_ask',
  description:
    'The output answers THIS ask, not another: fails when the input is present and BOTH relevance measurements fail at their thresholds — fewer than 35% of the ask\'s content terms appear in the output (keyword_overlap) AND fewer than a third of the output\'s sentences connect to the ask (topic_consistency). One measurement alone never fires it. A bare refusal or the ask handed back fires it directly. It ADVISES at the shipped thresholds, because comparing words fails correct paraphrases, and GATES once the deployment sets a threshold for either measurement. Skips whenever either measurement skips (no input, an output too brief to measure) and on an ask with fewer than two content terms, so a one-word right answer is never a fire. Lexical: a right answer that reuses none of the ask\'s words reads as off task — the published precision counts those',
  evalType: 'relevance',
  weight: 1,
  kind: 'policy',
  mechanism: 'formula',
  needs: ['output', 'input'],
  question: 'relevant',
  classes: ['off_task'],
  version: 1,
  evaluate(context: EvalContext): EvalRuleResult {
    const ko = keywordOverlap.evaluate(context);
    const tc = topicConsistency.evaluate(context);
    const askTerms = new Set(contentTerms(context.input ?? '')).size;
    /*
     * The threshold behind this rule is its two measurements' thresholds.
     * At the shipped defaults they are numbers WE chose, so the rule
     * advises; once a deployment sets either, the rule gates on the
     * deployment's word (2026-09-23 review: at the defaults it
     * failed 6 of 10 correct paraphrased answers and passed every refusal).
     */
    const configured = [ko, tc].some((r) => (r.evidence ?? []).some((e) => e.type === 'count' && e.thresholdSource === 'config'));
    const thresholdSource = configured ? 'config' : 'default';
    const ask = context.input ?? '';
    if (ask.trim().length > 0 && askTerms >= MIN_ASK_TERMS_TO_JUDGE) {
      // A decline that goes on to answer ("I can't see your order, but the policy gives you 30 days…")
      // shares the ask's terms and is judged on its content, not as a refusal.
      const refusal = isRefusal(context.output) && !(ko.passed && !ko.skipped);
      const echo = !refusal && isEcho(context.output, ask);
      if (refusal || echo) {
        return {
          ruleName: 'answers_the_ask',
          passed: false,
          score: 0,
          evidence: [{ type: 'count', stat: refusal ? 'refusal' : 'echo_of_ask', unit: 'outputs', value: 1, threshold: 1, thresholdSource }],
          message: refusal ? 'The output declines instead of answering the ask' : 'The output hands the ask back instead of answering it',
        };
      }
    }
    const skipped = ko.skipped ? ko : tc.skipped ? tc : askTerms < MIN_ASK_TERMS_TO_JUDGE ? { skipReason: `the ask has ${askTerms} content term${askTerms === 1 ? '' : 's'}; ${MIN_ASK_TERMS_TO_JUDGE} are needed to say an output answers something else` } : null;
    if (skipped) {
      // not_applicable, never "asked and could not answer": without an ask, or an output too brief to measure, the question does not apply — a critical rule's skip must not turn every output-only evaluation unknown.
      return { ruleName: 'answers_the_ask', passed: false, score: 0, skipped: true, skipClass: 'not_applicable', skipReason: skipped.skipReason ?? 'a relevance measurement skipped', message: 'Not judged: a relevance measurement skipped' };
    }
    const fired = !ko.passed && !tc.passed;
    const pct = (r: EvalRuleResult) => (r.value ? `${(r.value.value * 100).toFixed(0)}%` : '?');
    return {
      ruleName: 'answers_the_ask',
      passed: !fired,
      score: fired ? 0 : 1,
      // Its own count, with no guess in it: how many of the two measurements failed, against the two the definition requires.
      evidence: [{ type: 'count', stat: 'relevance_measurements_failed', unit: 'measurements', value: Number(!ko.passed) + Number(!tc.passed), threshold: 2, thresholdSource }],
      message: fired
        ? `The output answers something else: ${pct(ko)} of the ask's terms appear in it and ${pct(tc)} of its sentences connect to the ask — both below threshold`
        : `${pct(ko)} of the ask's terms appear in the output and ${pct(tc)} of its sentences connect to it; at least one measurement passes`,
    };
  },
};

export const relevanceRules: EvalRule[] = [keywordOverlap, topicConsistency, toolChoice, answersTheAsk];
