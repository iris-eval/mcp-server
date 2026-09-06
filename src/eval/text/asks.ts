/*
 * Splitting an ask into the things it asks for, and deciding which of them
 * an answer engaged with.
 *
 * The failure this exists to catch is the commonest real agent incompletion:
 * a user asks for three things and the answer addresses one. Transcript t-19
 * is exactly that, and until now no rule read the structure of an ask at
 * all, so the capability map's whole "did it complete the task" row was a
 * gap in every subject.
 *
 * ONE ASYMMETRY GOVERNS EVERY CHOICE BELOW. The rule fires when a part is
 * NOT covered, so every ambiguity has to resolve toward covered. Recall is
 * what this module gives away, deliberately and everywhere: an ask it
 * declines to split, a part it declines to measure and a coverage test it
 * resolves generously are all cheaper than telling a developer their agent
 * ignored something it answered in different words.
 *
 * THE SCOPE DECISION, AND THE MEASUREMENT THAT FORCED IT: only an ask that
 * DECLARES ITS OWN PARTS is split — a bullet list, a numbered or lettered
 * enumeration, or a first/second/finally sequence. Sentence boundaries and
 * connectors like "and also" are not part boundaries here.
 *
 * The first version split prose too, and four rounds of tuning could not
 * make it work: every constant that fixed a false positive on the real
 * transcripts destroyed recall on the corpus, and the precision lower bound
 * sat under the floor a rule needs to clear before its number is allowed
 * into a verdict. The reason is not the constants. A writer who numbers
 * their questions is DECLARING that these are separate things; a full stop
 * declares nothing, and a lexical test cannot recover the difference
 * between a second deliverable, a restatement, a manner instruction and a
 * line of pasted material.
 *
 * The cost, stated rather than hidden: a genuinely multi-part ask written as
 * flowing prose is not judged. That is a miss, and this rule prefers misses.
 *
 * It lives in text/ and is pinned into the website's vendored rule library,
 * because the rule reads only the input and the output — so unlike the rest
 * of the act layer it actually RUNS in the playground, and the two
 * implementations have to agree byte for byte.
 */
import { contentTerms } from '../rules/relevance.js';

/**
 * Longest input this rule will read.
 *
 * The guard it cannot ship without. `input` in this product routinely
 * carries the SOURCE MATERIAL as well as the ask — transcript t-07 is a
 * pasted support ticket — and splitting a pasted document into "parts" and
 * then finding a three-bullet summary does not cover them would fire on
 * every summarisation task there is. Below this length a document is rare;
 * above it, an ask is.
 */
export const MAX_ASK_CHARS = 1500;
/** More parts than this is a specification, and a lexical covering test degrades on one. */
export const MAX_ASK_PARTS = 12;
/** A part with fewer content terms than this cannot be measured at all. */
export const MIN_MEASURABLE_TERMS = 2;

/**
 * Terms that ask for a MANNER of answering rather than for any subject.
 *
 * A part built only from these is a meta-ask: "Cite a source", "Point me at
 * the spec". An answer that DOES cite a source has no reason to repeat the
 * word "cite", so a lexical test over such a part measures vocabulary luck
 * and every bad toss lands as a false positive — both of those fired
 * against the real transcripts while the answer had plainly complied.
 *
 * Raising the term floor to three was the first attempt and it was the wrong
 * instrument: it fixed those two and then made twenty-seven of thirty-one
 * corpus cases unmeasurable, because an ordinary enumerated part like "which
 * bundle each belongs to" carries exactly two terms. The floor is a blunt
 * proxy for what actually matters, which is whether the part names a
 * SUBJECT. This list is that, stated directly.
 */
export const GENERIC_ASK_TERMS: ReadonlySet<string> = new Set([
  // STEMS, as contentTerms produces them — not the words. The first version
  // listed the words and silently matched nothing, which the unit test
  // caught: "cite a source" kept "cit" as a subject term and stayed
  // measurable. Several of the words this list was reaching for (answer,
  // explain, tell, say, show, give) are stopwords already and never appear.
  'cit', 'sourc', 'link', 'spec', 'referenc', 'point', 'exampl', 'not',
  'quot', 'ment', 'provid', 'includ',
]);
/** Ceiling on how many subject terms a part may require, however long it is. */
export const COVER_MAX_REQUIRED = 2;
/** Shared leading characters that count two words as the same word. */
export const PREFIX_MATCH_CHARS = 4;

/** A line that opens a list item. The same shape relevance.ts already uses. */
export const LIST_MARKERS = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/;

/**
 * Imperative heads. A fragment beginning with one is an ask even when it
 * carries a single content term, which is what lets "review" and "merge"
 * be recognised as two actions — and then dropped again by the
 * measurability filter, because neither can be measured.
 */
export const ASK_VERBS: ReadonlySet<string> = new Set([
  'summarise', 'summarize', 'explain', 'describe', 'list', 'write', 'draft', 'add', 'fix',
  'update', 'create', 'delete', 'remove', 'check', 'verify', 'confirm', 'find', 'search',
  'look', 'read', 'run', 'test', 'build', 'deploy', 'review', 'merge', 'open', 'close',
  'send', 'reply', 'translate', 'convert', 'refactor', 'rename', 'compare', 'rank', 'sort',
  'count', 'calculate', 'estimate', 'plan', 'propose', 'recommend', 'suggest', 'show',
  'tell', 'give', 'provide', 'generate', 'produce', 'make', 'include', 'cite', 'point',
  'identify', 'extract', 'analyse', 'analyze', 'evaluate', 'assess', 'document', 'implement',
  'install', 'configure', 'set', 'enable', 'disable', 'start', 'stop', 'restart', 'print',
  'output', 'format', 'optimise', 'optimize', 'benchmark', 'profile', 'debug', 'trace',
  'log', 'patch', 'revert', 'push', 'pull', 'commit', 'tag', 'release', 'publish', 'sketch',
  'outline', 'draw', 'name', 'pick', 'choose', 'walk', 'quote',
]);

/**
 * Openers that make a fragment an instruction about HOW to answer rather
 * than a thing to deliver.
 *
 * "Answer from the engine source, not the docs" is a sourcing constraint,
 * and an answer that complies has no reason to repeat it — transcript t-05
 * fired on exactly that. This rule judges whether the things asked for were
 * delivered; whether the manner was obeyed is a different question and one
 * this test cannot see.
 */
export const MANNER_PREFIXES: readonly string[] = [
  'answer from', 'answer using', 'answer in', 'answer with', 'base it on', 'base your',
  'use only', 'use the', 'do not use', "don't use", 'not the', 'keep it', 'be brief',
  'be concise', 'in plain', 'in your own words', 'no more than', 'at most', 'briefly',
  'without ', 'avoid ', 'cite your', 'show your working', 'think step',
];

/** Is this fragment an instruction about form rather than a deliverable? */
export function isManner(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return MANNER_PREFIXES.some((m) => lower.startsWith(m));
}

/**
 * Verbs whose deliverable IS the answer.
 *
 * "Draft a reply to this email" is discharged by the output BEING a reply,
 * and no lexical test can see that: transcript t-09 answers with a complete
 * drafted email and the rule called the instruction unaddressed. When the
 * ask is to produce prose and substantial prose came back, the honest
 * reading is that the agent attempted it — and this module resolves every
 * ambiguity toward covered, because the cost of the other direction is
 * telling a developer their agent ignored something it plainly did.
 *
 * The named cost: an agent asked to draft a reply that writes a substantial
 * paragraph about something else entirely reads as covered here. That is
 * off-task, which is a different question and a different rule.
 */
export const PRODUCE_VERBS: ReadonlySet<string> = new Set([
  'draft', 'write', 'compose', 'summarise', 'summarize', 'translate', 'generate',
  'produce', 'rewrite', 'reply', 'respond', 'outline', 'sketch',
]);

/** Words an output needs before a produce-verb ask counts as attempted. */
export const MIN_PRODUCED_WORDS = 25;

/** Does this part ask for prose that the output itself would be? */
export function isProduceAsk(text: string): boolean {
  const bare = text.trim().toLowerCase().replace(/^(?:please|can you|could you|would you)\s+/, '');
  const first = bare.split(/[^a-z]+/)[0] ?? '';
  return PRODUCE_VERBS.has(first);
}

export interface AskPart {
  text: string;
  start: number;
  end: number;
  /** The ordinal the ask used for this part, when it used one: 1, 2, 3 … */
  ordinal: number | null;
}

/** Spans of fenced code, which are opaque: never split, never a source of terms. */
export function askFencedSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let from = text.indexOf('```');
  while (from >= 0) {
    const close = text.indexOf('```', from + 3);
    if (close < 0) {
      spans.push([from, text.length]);
      break;
    }
    spans.push([from, close + 3]);
    from = text.indexOf('```', close + 3);
  }
  return spans;
}

function withinAskSpan(spans: ReadonlyArray<[number, number]>, at: number): boolean {
  return spans.some(([a, b]) => at >= a && at < b);
}

/**
 * Inline enumerations, accepted only when at least two markers appear in
 * ASCENDING sequence from the first ordinal.
 *
 * The guard that stops "step 3 of the pipeline" or a lone "(1)" splitting an
 * ask that has one part.
 */
export function enumerationRuns(text: string): Array<{ at: number; ordinal: number }> {
  const found: Array<{ at: number; ordinal: number }> = [];
  const pattern = /(?:^|\s)\(?(\d{1,2}|[a-e]|i{1,3}v?)\)[\s]/gi;
  let m = pattern.exec(text);
  while (m !== null) {
    const token = m[1].toLowerCase();
    const ordinal = /^\d+$/.test(token)
      ? Number(token)
      : token.length <= 3 && /^i+v?$/.test(token)
        ? { i: 1, ii: 2, iii: 3, iv: 4 }[token] ?? 0
        : token.charCodeAt(0) - 96;
    found.push({ at: m.index + m[0].indexOf(m[1]), ordinal });
    m = pattern.exec(text);
  }
  if (found.length < 2) return [];
  const start = found[0].ordinal;
  const run: Array<{ at: number; ordinal: number }> = [found[0]];
  for (const f of found.slice(1)) {
    if (f.ordinal === run[run.length - 1].ordinal + 1) run.push(f);
  }
  return run.length >= 2 && start <= 2 ? run : [];
}

/**
 * Ordinal words that enumerate as plainly as "(1)" does.
 *
 * Accepted on the same terms: at least two, in ascending sequence, starting
 * at the first or second. A lone "finally" is prose.
 */
export const ORDINAL_WORDS: ReadonlyArray<[string, number]> = [
  ['first,', 1], ['first ', 1], ['second,', 2], ['second ', 2], ['third,', 3], ['third ', 3],
  ['fourth,', 4], ['fourth ', 4], ['finally,', 98], ['finally ', 98], ['lastly,', 99], ['lastly ', 99],
];

/** Ordinal-word runs, as offsets, on the same ascending rule as the marker form. */
export function ordinalWordRuns(text: string): Array<{ at: number; ordinal: number }> {
  const lower = text.toLowerCase();
  const found: Array<{ at: number; ordinal: number }> = [];
  for (const [word, ordinal] of ORDINAL_WORDS) {
    let at = lower.indexOf(word);
    while (at >= 0) {
      const before = at === 0 ? ' ' : lower[at - 1];
      if (before === ' ' || before === String.fromCharCode(10) || at === 0) found.push({ at, ordinal });
      at = lower.indexOf(word, at + 1);
    }
  }
  found.sort((a, b) => a.at - b.at);
  const deduped = found.filter((f, i) => i === 0 || f.at !== found[i - 1].at);
  if (deduped.length < 2) return [];
  const run: Array<{ at: number; ordinal: number }> = [deduped[0]];
  for (const f of deduped.slice(1)) {
    if (f.ordinal > run[run.length - 1].ordinal) run.push(f);
  }
  return run.length >= 2 && run[0].ordinal <= 2 ? run : [];
}

/** The things this ask asks for, in order, with offsets into the text given. */
export function splitAsk(text: string): AskPart[] {
  const fenced = askFencedSpans(text);
  const parts: AskPart[] = [];

  const bulletLines: Array<{ line: string; at: number }> = [];
  let cursor = 0;
  for (const line of text.split('\n')) {
    const at = cursor;
    cursor += line.length + 1;
    if (withinAskSpan(fenced, at)) continue;
    if (LIST_MARKERS.test(line)) bulletLines.push({ line, at });
  }
  // A lone bullet is prose; two or more are a list.
  if (bulletLines.length >= 2) {
    for (const [i, { line, at }] of bulletLines.entries()) {
      const body = line.replace(LIST_MARKERS, '');
      const offset = line.length - body.length;
      const trimmed = body.trim();
      if (trimmed.length === 0) continue;
      parts.push({ text: trimmed, start: at + offset, end: at + offset + trimmed.length, ordinal: i + 1 });
    }
    return parts.slice(0, MAX_ASK_PARTS);
  }

  const runs = enumerationRuns(text).filter((r) => !withinAskSpan(fenced, r.at));
  if (runs.length >= 2) {
    for (const [i, run] of runs.entries()) {
      const from = run.at;
      const to = i + 1 < runs.length ? runs[i + 1].at : text.length;
      const body = text.slice(from, to).replace(/^\(?[0-9a-e]{1,2}\)?[\s]/i, '');
      const offset = to - from - body.length;
      // The slice runs to the NEXT marker, so it carries that marker's
      // opening bracket and any joining word. Trimming them keeps a part's
      // text readable in the evidence and keeps its terms honest.
      const trimmed = body.replace(/[\s(]*(?:and|or|then)?[\s(]*$/i, '').trim();
      if (trimmed.length === 0) continue;
      parts.push({ text: trimmed, start: from + offset, end: from + offset + trimmed.length, ordinal: run.ordinal });
    }
    return parts.slice(0, MAX_ASK_PARTS);
  }

  const words = ordinalWordRuns(text).filter((r) => !withinAskSpan(fenced, r.at));
  if (words.length >= 2) {
    for (const [i, run] of words.entries()) {
      const from = run.at;
      const to = i + 1 < words.length ? words[i + 1].at : text.length;
      const body = text.slice(from, to).replace(/^[a-z]+,?\s*/i, '');
      const offset = to - from - body.length;
      const trimmed = body.trim();
      if (trimmed.length === 0) continue;
      parts.push({ text: trimmed, start: from + offset, end: from + offset + trimmed.length, ordinal: i + 1 });
    }
    return parts.slice(0, MAX_ASK_PARTS);
  }

  /*
   * No declared parts. One ask, and the rule will skip rather than guess
   * where a prose ask divides — see the scope decision at the top of this
   * file, which the measurement forced rather than preference choosing.
   */
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const offset = text.indexOf(trimmed);
  return [{ text: trimmed, start: offset, end: offset + trimmed.length, ordinal: null }];
}

/**
 * Parts this rule will measure.
 *
 * A part carrying one thin verb — t-19's "how do I change it" reduces to a
 * single high-frequency term — cannot be measured by any lexical test: the
 * answer might say set, pass, override or configure and never say change.
 * Counting it would not measure incompletion, it would measure vocabulary
 * luck, and every bad toss of that coin lands as a FALSE POSITIVE because
 * uncovered is what fires. So the rule measures what it can measure and
 * reports how much it could not.
 */
export function measurableParts(parts: readonly AskPart[]): AskPart[] {
  return parts.filter((p) => {
    if (isManner(p.text)) return false;
    const terms = new Set(contentTerms(p.text));
    if (terms.size < MIN_MEASURABLE_TERMS) return false;
    // At least one term has to name a subject. A part built only from
    // ask-words is asking HOW to answer, and no lexical test can tell
    // whether it was satisfied.
    return [...terms].some((t) => !GENERIC_ASK_TERMS.has(t));
  });
}

/** Index of the output's terms, plus their leading prefixes, built once. */
export function answerIndex(output: string): { terms: Set<string>; prefixes: Set<string> } {
  const terms = new Set(contentTerms(output));
  const prefixes = new Set<string>();
  for (const t of terms) {
    if (t.length >= PREFIX_MATCH_CHARS) prefixes.add(t.slice(0, PREFIX_MATCH_CHARS));
  }
  return { terms, prefixes };
}

/**
 * The terms of a part that name its SUBJECT.
 *
 * The coverage test is measured over these and not over every word, because
 * "explain", "say" and "tell" are how an ask is phrased rather than what it
 * asks about, and requiring an answer to echo them measures politeness.
 */
export function askSubjectTerms(part: AskPart): string[] {
  return [...new Set(contentTerms(part.text))].filter((t) => !GENERIC_ASK_TERMS.has(t));
}

/** How many of this part's subject terms the answer engaged with. */
export function hitsPart(part: AskPart, index: { terms: Set<string>; prefixes: Set<string> }): number {
  let hits = 0;
  for (const term of askSubjectTerms(part)) {
    if (index.terms.has(term)) {
      hits += 1;
      continue;
    }
    if (term.length >= PREFIX_MATCH_CHARS && index.prefixes.has(term.slice(0, PREFIX_MATCH_CHARS))) hits += 1;
  }
  return hits;
}

/**
 * How many subject terms this part needs engaged before it counts as
 * covered: half of them, at least one, never more than two.
 *
 * A FLAT bar of two was the first version and it was wrong in a way the
 * corpus made obvious. For a two-term part, "two hits" is not a generous
 * bar — it demands the answer echo the ask's exact vocabulary, and an answer
 * that says "it listens on 6920" to "what the dashboard port is" fails it
 * while plainly answering. Scaling keeps the bar generous at every length,
 * which is the direction this module resolves everything.
 */
export function requiredHits(part: AskPart): number {
  const terms = askSubjectTerms(part).length;
  return Math.min(COVER_MAX_REQUIRED, Math.max(1, Math.ceil(terms / 2)));
}

/**
 * Did the answer address this part?
 *
 * Two absolute terms rather than a proportion. Measurable parts carry at
 * least two terms by construction, so this is a uniform, generous bar at
 * every length — where a ratio of one half is a coin flip on a two-term part
 * and a bar a correct, concise answer routinely fails on an eight-term one.
 *
 * The ordinal mirror is the second door. An agent answering a numbered ask
 * overwhelmingly repeats the numbering, and mirroring is strong evidence of
 * engagement even when the vocabulary diverges completely.
 */
export function coversPart(part: AskPart, output: string, index: { terms: Set<string>; prefixes: Set<string> }): boolean {
  if (hitsPart(part, index) >= requiredHits(part)) return true;
  if (isProduceAsk(part.text) && (output.match(/\S+/g) ?? []).length >= MIN_PRODUCED_WORDS) return true;
  if (part.ordinal !== null) {
    const n = String(part.ordinal);
    const letter = String.fromCharCode(96 + part.ordinal);
    for (const mark of [`(${n})`, `${n}.`, `${n})`, `(${letter})`, `${letter})`]) {
      if (output.includes(mark)) return true;
    }
  }
  return false;
}
