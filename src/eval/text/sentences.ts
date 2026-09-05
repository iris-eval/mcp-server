/*
 * One sentence splitter, for the two rules that count or walk sentences.
 *
 * Both had their own, and both were wrong in the same way. `sentence_count`
 * split on `/[.!?]+/`, so "The latency is 3.5 seconds." counted as two
 * sentences and "Dr. Chen approved it." as two more; the arc-zero review
 * measured the damage at 43% of that rule's family. `topic_consistency`
 * split on a full stop followed by whitespace, which fixes the decimal only
 * when the decimal has no space after it and never fixes the abbreviation.
 *
 * A sentence ends at `.`, `!` or `?` when what follows looks like the start
 * of a new sentence and what precedes is not one of the things that ends in
 * a full stop without ending a sentence:
 *
 *   - never between digits, so 3.5 and 1.2.3 stay whole;
 *   - never after a closed list of abbreviations (Dr, Mr, Mrs, Ms, e.g,
 *     i.e, vs, etc, No, Fig, St, Inc, Ltd, Jr, Sr, approx, cf, al);
 *   - never after a single capital letter, which is an initial (J. Smith);
 *   - only when the next non-space character starts a sentence: an
 *     uppercase letter, an opening quote or bracket, or a digit.
 *
 * The list is closed on purpose. An open-ended abbreviation heuristic
 * (a short token ending in a full stop) swallows real sentence ends —
 * "It was fun. Then we left." — and this splitter is used to COUNT, where
 * missing a break is as wrong as inventing one.
 */

/**
 * Abbreviations that are essentially never the last word of a sentence, so
 * the full stop after them is punctuation and not an end. Lowercase, no
 * trailing stop.
 */
const ALWAYS_ABBREVIATION = new Set([
  'dr', 'mr', 'mrs', 'ms', 'prof', 'sr', 'jr', 'st', 'mt',
  'e.g', 'i.e', 'vs', 'al', 'cf', 'approx', 'est',
  'dept', 'univ', 'a.m', 'p.m', 'u.s', 'u.k',
]);

/**
 * Abbreviations that are ALSO ordinary sentence endings — "shipped in Oct.
 * The rollout held" ends a sentence; "shipped on Oct. 5" does not. What
 * separates them is what follows: a number means the abbreviation is being
 * used as a label, anything else means the sentence ended. Guessing either
 * way unconditionally is wrong about half the time, and this splitter is
 * used to COUNT, where a missed break costs exactly as much as an invented
 * one.
 */
const ABBREVIATION_BEFORE_NUMBER = new Set([
  'no', 'fig', 'eq', 'ch', 'vol', 'pp', 'etc',
  'inc', 'ltd', 'co', 'corp',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

const TERMINATORS = new Set(['.', '!', '?']);

/** True when the character can open a new sentence. */
function opensSentence(ch: string): boolean {
  if (ch === undefined) return false;
  if (ch >= 'A' && ch <= 'Z') return true;
  if (ch >= '0' && ch <= '9') return true;
  return '"‘’“”\'([{*_#-—'.includes(ch);
}

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';

/** The token immediately before `at`, lowercased, without its trailing stop. */
function precedingToken(text: string, at: number): string {
  let i = at - 1;
  while (i >= 0 && !/[\s(["']/.test(text[i])) i--;
  return text.slice(i + 1, at).toLowerCase();
}

/**
 * Named sentencesOf, not sentencesOf: the hallucination rule in
 * src/eval/rules/safety.ts has its own sentencesOf that also breaks on
 * every newline, because it wants per-line units for grounding checks. The
 * two are not the same job and unifying them would move that rule's
 * numbers, so it is a separate measured change, not a rename.
 *
 * Splits `text` into sentences. Never returns an empty sentence; a text with
 * no terminator is one sentence. Line breaks do not split on their own — a
 * wrapped paragraph is one sentence — but a blank line does, because a new
 * block is a new thought and a bullet list is not one long sentence.
 */
export function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // A blank line ends a sentence whatever came before it.
    if (ch === '\n' && /^\s*\n/.test(text.slice(i + 1))) {
      const piece = text.slice(start, i).trim();
      if (piece.length > 0) out.push(piece);
      start = i + 1;
      continue;
    }

    if (!TERMINATORS.has(ch)) continue;

    // 3.5 — a full stop between digits is a decimal point.
    if (ch === '.' && isDigit(text[i - 1]) && isDigit(text[i + 1])) continue;

    // Run past a cluster of terminators ("What?!").
    let end = i;
    while (end + 1 < text.length && TERMINATORS.has(text[end + 1])) end++;

    // Closing quotes and brackets belong to the sentence that ends here.
    let after = end + 1;
    while (after < text.length && '"’”\')]}'.includes(text[after])) after++;

    // What comes next has to look like a new sentence.
    let next = after;
    while (next < text.length && /[ \t\r\n]/.test(text[next])) next++;
    /*
     * No whitespace after the stop is usually a mid-token full stop — a
     * version (v0.10.0), a filename (package.json), a hostname
     * (iris-eval.com/proof) — and must not break. The exception is a
     * following CAPITAL, which is a missing space between two sentences
     * ("...ready.Ship it") and not a token: no filename or version has one.
     */
    if (next === after && next < text.length && !(text[next] >= 'A' && text[next] <= 'Z')) continue;
    if (next < text.length && !opensSentence(text[next])) continue;

    // Dr. Chen — an abbreviation, not an end.
    if (ch === '.') {
      const token = precedingToken(text, i);
      if (ALWAYS_ABBREVIATION.has(token)) continue;
      // Oct. 5 is a date; "in Oct. The rollout held" is two sentences.
      if (ABBREVIATION_BEFORE_NUMBER.has(token) && isDigit(text[next])) continue;
      // A single capital letter is an initial: J. Smith.
      if (token.length === 1 && /[a-z]/i.test(token)) continue;
    }

    const piece = text.slice(start, after).trim();
    if (piece.length > 0) out.push(piece);
    start = after;
    i = after - 1;
  }
  const tail = text.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

/** How many sentences the text contains. The one number `sentence_count` reports. */
export function countSentences(text: string): number {
  return sentencesOf(text).length;
}
