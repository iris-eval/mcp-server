/*
 * One normalisation pass, shared by every rule that matches text.
 *
 * The problem it solves is measured, not hypothetical. `npm run proof`
 * publishes a transforms table: for every positive a critical rule catches,
 * the text inside the evidence span is transformed the way an evader would
 * transform it, and the rule is re-run. Before this module, `no_pii` kept
 * 38% of its catches under a zero-width space, 22% under Cyrillic
 * homoglyphs and **none at all** under full-width digits, and
 * `no_blocklist_words` survived nothing but a change of case.
 *
 * What it does, in order, per grapheme cluster:
 *   1. drops format characters that carry no meaning — zero-width spaces
 *      and joiners, the soft hyphen, the byte-order mark;
 *   2. NFKC-folds the cluster, which turns full-width and mathematical
 *      alphanumerics into ASCII (４１１１ → 4111, 𝐩𝐚𝐬𝐬 → pass);
 *   3. maps the confusables NFKC does NOT fold — Cyrillic and Greek letters
 *      that are drawn like Latin ones (раssword with a Cyrillic а and р);
 *   4. collapses every run of whitespace to ONE character — a newline when
 *      the run contains one, a space otherwise. Line structure is meaning:
 *      a forged "System:" line and a fenced block are line-shaped, and
 *      flattening newlines to spaces measurably cost the injection rule
 *      recall on three transforms. Horizontal runs carry no such meaning.
 *
 * What it deliberately does NOT do is leetspeak (0 → o, 1 → i). That
 * substitution is correct for injection phrasing and catastrophic for
 * everything else: it would turn a credit card number into letters and
 * blind every digit-based detector. The injection rule applies it on top of
 * this pass, to this pass's output, and owns it alone.
 *
 * Every rule that matches on `text` reports evidence through `map`, so a
 * span still indexes the RAW output the caller sent — the arc-1 contract
 * ("spans are offsets into the raw text") is what makes redaction and the
 * transforms measurement correct, and normalising without a map would
 * quietly break it.
 */

/** Format characters that carry no textual meaning and are pure evasion when they sit inside a token. */
const DROPPED = new Set([
  '​', // zero-width space
  '‌', // zero-width non-joiner
  '‍', // zero-width joiner
  '‎', // left-to-right mark
  '‏', // right-to-left mark
  '⁠', // word joiner
  '﻿', // byte-order mark / zero-width no-break space
  '­', // soft hyphen
]);

/**
 * Letters that NFKC leaves alone but a reader cannot tell apart from Latin.
 * Cyrillic first, then Greek; lowercase and uppercase where both are
 * confusable. Deliberately conservative: only characters whose common
 * rendering is indistinguishable in the fonts an agent's output is read in.
 */
const CONFUSABLES = new Map<string, string>([
  // Cyrillic → Latin
  ['а', 'a'], ['А', 'A'],
  ['е', 'e'], ['Е', 'E'],
  ['о', 'o'], ['О', 'O'],
  ['р', 'p'], ['Р', 'P'],
  ['с', 'c'], ['С', 'C'],
  ['х', 'x'], ['Х', 'X'],
  ['у', 'y'], ['У', 'Y'],
  ['к', 'k'], ['К', 'K'],
  ['м', 'm'], ['М', 'M'],
  ['н', 'h'], ['Н', 'H'],
  ['т', 't'], ['Т', 'T'],
  ['в', 'v'], ['В', 'B'],
  ['і', 'i'], ['І', 'I'],
  ['ј', 'j'], ['Ј', 'J'],
  ['ѕ', 's'], ['Ѕ', 'S'],
  ['б', '6'],
  ['г', 'r'],
  ['з', '3'],
  ['һ', 'h'],
  ['ҙ', 'z'],
  // Greek → Latin
  ['ο', 'o'], ['Ο', 'O'],
  ['α', 'a'], ['Α', 'A'],
  ['ε', 'e'], ['Ε', 'E'],
  ['ρ', 'p'], ['Ρ', 'P'],
  ['τ', 't'], ['Τ', 'T'],
  ['ν', 'v'], ['Ν', 'N'],
  ['υ', 'u'], ['Υ', 'Y'],
  ['ι', 'i'], ['Ι', 'I'],
  ['κ', 'k'], ['Κ', 'K'],
  ['β', 'B'], ['Β', 'B'],
  ['η', 'n'], ['Η', 'H'],
  ['χ', 'x'], ['Χ', 'X'],
  ['μ', 'u'], ['Μ', 'M'],
  ['γ', 'y'], ['Ζ', 'Z'],
  ['Φ', 'O'],
  // Other scripts whose letters are drawn as Latin
  ['ԁ', 'd'],
  ['ԛ', 'q'],
  ['ɡ', 'g'],
  ['ẞ', 'S'],
  ['ո', 'n'],
  ['ս', 'u'],
  ['օ', 'o'],
]);

export interface Normalised {
  /** The folded text every pattern should match against. */
  text: string;
  /**
   * `map[i]` is the offset in the RAW string that normalised character `i`
   * came from. Length is `text.length + 1`; the final entry is the raw
   * length, so a normalised span `[s, e)` becomes the raw span
   * `[map[s], map[e])` with no special case at the end of the string.
   */
  map: Int32Array;
  /** True when normalisation changed nothing, so callers can skip a second pass. */
  unchanged: boolean;
}

let segmenter: Intl.Segmenter | undefined;
function graphemes(raw: string): Intl.Segments | string[] {
  if (typeof Intl?.Segmenter === 'function') {
    segmenter ??= new Intl.Segmenter('en', { granularity: 'grapheme' });
    return segmenter.segment(raw);
  }
  // Environments without Intl.Segmenter fall back to code points, which is
  // correct for everything this pass folds and only differs on combining
  // sequences it would leave alone anyway.
  return [...raw];
}

const WHITESPACE = /\s/u;
const LINE_BREAK = /[\n\r\u2028\u2029]/u;

/** Folds `raw` for matching and returns the offset map that puts evidence back on the raw text. */
export function normalise(raw: string): Normalised {
  const out: string[] = [];
  const offsets: number[] = [];
  /** The whitespace run being accumulated: where it started, and whether it broke a line. */
  let run: { at: number; hadBreak: boolean } | null = null;
  let changed = false;

  const push = (chars: string, at: number): void => {
    for (const ch of chars) {
      out.push(ch);
      offsets.push(at);
    }
  };

  /** Emits the pending whitespace run as one character: a newline if it broke a line, else a space. */
  const flushRun = (): void => {
    if (run === null) return;
    const ch = run.hadBreak ? '\n' : ' ';
    if (raw.slice(run.at, run.at + 1) !== ch) changed = true;
    push(ch, run.at);
    run = null;
  };

  const segments = graphemes(raw);
  const iterate = (rawCluster: string, index: number): void => {
    /*
     * Strip the format characters from INSIDE the cluster, not just from
     * clusters that are one. A zero-width non-joiner between two digits
     * binds into the neighbouring grapheme, so a whole-cluster test misses
     * exactly the evasion this exists to fold.
     */
    let cluster = rawCluster;
    if (cluster.length > 1 || DROPPED.has(cluster)) {
      let stripped = '';
      for (const ch of cluster) if (!DROPPED.has(ch)) stripped += ch;
      if (stripped !== cluster) {
        changed = true;
        cluster = stripped;
      }
    }
    if (cluster === '') return;
    if (WHITESPACE.test(cluster)) {
      const hadBreak = LINE_BREAK.test(cluster);
      if (run === null) run = { at: index, hadBreak };
      else {
        run.hadBreak ||= hadBreak;
        changed = true;
      }
      return;
    }
    flushRun();
    let folded = cluster.normalize('NFKC');
    if (folded !== cluster) changed = true;
    if (CONFUSABLES.size > 0) {
      let mapped = '';
      for (const ch of folded) {
        const sub = CONFUSABLES.get(ch);
        if (sub === undefined) mapped += ch;
        else {
          mapped += sub;
          changed = true;
        }
      }
      folded = mapped;
    }
    // A cluster that folds away entirely (a lone combining mark NFKC drops)
    // contributes nothing; its offset is covered by the next kept character.
    push(folded, index);
  };

  if (Array.isArray(segments)) {
    let at = 0;
    for (const cluster of segments) {
      iterate(cluster, at);
      at += cluster.length;
    }
  } else {
    for (const { segment, index } of segments) iterate(segment, index);
  }

  flushRun();

  const map = new Int32Array(offsets.length + 1);
  map.set(offsets);
  map[offsets.length] = raw.length;
  return { text: out.join(''), map, unchanged: !changed && out.length === raw.length };
}

/**
 * A span in normalised coordinates as a span in raw coordinates. Always
 * widens rather than narrows: when characters were dropped between the last
 * matched character and the next kept one, the raw span covers them, which
 * is what a reader wants — the evasion is part of the evidence.
 */
export function toRawSpan(n: Normalised, start: number, end: number): [number, number] {
  const s = Math.max(0, Math.min(start, n.map.length - 1));
  const e = Math.max(s, Math.min(end, n.map.length - 1));
  return [n.map[s], n.map[e]];
}

