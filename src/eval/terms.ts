/*
 * One tokenizer for every rule that compares vocabularies (0.16.0 moved
 * it out of the relevance bundle so the tool-choice rule could read it
 * without a module cycle). The relevance rules, ask_coverage and tool_choice
 * all agree on what a "term" is:
 *   - stopwords (articles, pronouns, auxiliaries, question words, the
 *     request verbs — "explain", "summarise", "tell me" — and the form of
 *     the deliverable — "paragraph", "bullets", "summary") are not terms;
 *   - code identifiers, paths and flags are SPLIT into their words
 *     (`EvalEngine.evaluateAll()` → eval, engine, evaluate; `src/index.ts`
 *     → src, index) rather than dropped: the words inside an identifier
 *     ARE topic vocabulary;
 *   - numbers and fenced code blocks are neutral (neither for nor against);
 *   - a light stemmer folds inflections (purge/purged/purging, rule/rules,
 *     evaluate/evaluation/evaluator) so the same word in a different form
 *     still counts. It is deliberately crude — both sides get the same
 *     treatment, so an imperfect stem only lowers sensitivity, never
 *     invents a match.
 */

export const STOPWORDS = new Set(
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

export const FENCED_CODE = /```[\s\S]*?```/g;
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
