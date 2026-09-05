import type { EvalRule, EvalContext, EvalRuleResult } from '../../types/eval.js';
import { sentencesOf } from '../text/sentences.js';

/*
 * Relevance rules — one tokenizer, two DISTINCT signals.
 *
 * Redesigned after the arc-one acceptance pass ran twenty-four transcripts
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

const STOPWORDS = new Set(
  (
    'a an the and or nor but if then else than that this these those there here it its is are was were be been being ' +
    'am do does did done doing have has had having will would shall should can could may might must not no yes of in on ' +
    'at to for from by with without into onto over under about above below between among through during before after ' +
    'again further once out off up down as so such very really just only also too either neither both each every all any ' +
    'some few more most less least other another same own new old first second third next last one two three four five ' +
    'ten i me my mine we us our ours you your yours he him his she her hers they them their theirs who whom whose which ' +
    'what when where why how because while until unless since although though even ever never always often sometimes ' +
    'usually still yet already now anywhere everywhere something anything nothing everything someone anyone everyone ' +
    'nobody thing things way ways kind kinds sort sorts lot lots much many get gets got getting give gives gave given ' +
    'giving take takes took taken taking make makes made making use uses used using see sees saw seen seeing know knows ' +
    'knew known knowing think thinks thought thinking want wants wanted wanting need needs needed needing let lets tell ' +
    'tells told telling say says said saying ask asks asked asking read reads reading look looks looked looking find ' +
    'finds found finding show shows showed shown showing explain explains explained explaining describe describes ' +
    'described describing summarise summarize summarises summarizes summarised summarized answer answers answered ' +
    'answering question questions please help helps helped helping like likes liked well good bad better best right ' +
    'wrong true false able keep keeps kept put puts go goes went gone going come comes came coming back also etc via per ' +
    // The FORM of the deliverable, not its subject — "a one-paragraph
    // description", "a few bullets", "a short summary", "in detail".
    'paragraph paragraphs sentence sentences bullet bullets summary overview description brief briefly detail details ' +
    'detailed word words line lines short long quick quickly ' +
    // URL and domain furniture — "iris-eval.com" splits into iris, eval, com.
    'com org net www http https'
  ).split(' '),
);

/**
 * Light stemmer: plurals, -ing/-ed/-ly, -ation/-ator/-ate/-ion, a trailing
 * e, and a doubled final consonant. Crude on purpose (see the header):
 * both sides are stemmed identically.
 */
export function stemTerm(word: string): string {
  let w = word;
  if (w.length <= 3) return w;
  if (w.endsWith('ies')) w = w.slice(0, -3) + 'i';
  else if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('ly')) w = w.slice(0, -2);
  else if (w.length > 6 && w.endsWith('ation')) w = w.slice(0, -5);
  else if (w.length > 5 && w.endsWith('ator')) w = w.slice(0, -4);
  else if (w.length > 5 && w.endsWith('ate')) w = w.slice(0, -3);
  else if (w.length > 5 && w.endsWith('ion')) w = w.slice(0, -3);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  if (w.length > 3 && /([^aeiou])\1$/.test(w) && !/[lsz]$/.test(w)) w = w.slice(0, -1);
  return w;
}

const FENCED_CODE = /```[\s\S]*?```/g;
const CAMEL_BOUNDARY = /([a-z])([A-Z])/g;
const WORD = /[a-z]{3,}/g;

/**
 * Content terms of a text: fenced code removed, camelCase split, everything
 * that is not a run of three or more letters treated as a separator (so
 * paths, flags, snake_case and dotted identifiers fall apart into their
 * words and numbers vanish), stopwords dropped, the rest stemmed.
 */
export function contentTerms(text: string): string[] {
  const terms: string[] = [];
  const lowered = text.replace(FENCED_CODE, '\n').replace(CAMEL_BOUNDARY, '$1 $2').toLowerCase();
  for (const match of lowered.matchAll(WORD)) {
    if (STOPWORDS.has(match[0])) continue;
    terms.push(stemTerm(match[0]));
  }
  return terms;
}

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
      evidence: [{ type: 'count', stat: 'input_terms_in_output', unit: 'ratio', value: ratio, threshold, thresholdSource: threshold === 0.35 ? 'default' : 'config' }],
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
      evidence: [{ type: 'count', stat: 'connected_sentences', unit: 'ratio', value: ratio, threshold, thresholdSource: threshold === DEFAULT_TOPIC_THRESHOLD ? 'default' : 'config' }],
      message: `Topic consistency: ${connected}/${sentences} content sentences connect to the input's topic (${(ratio * 100).toFixed(0)}%)`,
    };
  },
};

export const relevanceRules: EvalRule[] = [keywordOverlap, topicConsistency];
