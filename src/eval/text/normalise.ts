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
 *   1. drops characters that are invisible and carry no text — every
 *      format character (zero-width spaces and joiners, direction marks
 *      and overrides, the soft hyphen, the byte-order mark, the invisible
 *      operators, tag characters) and the variation selectors;
 *   2. strips the combining accents used on Latin script (U+0300–036F and
 *      the extended diacritic blocks), from both a decomposed letter and a
 *      precomposed one, so "ígnore" and "i\u0301gnore" read as "ignore" and
 *      an accent dropped into an SSN or an injection no longer hides it
 *      (2026-09-23 red team). Marks that carry meaning in other scripts —
 *      Devanagari vowel signs, Arabic harakat — are left alone;
 *   3. NFKC-folds the cluster, which turns full-width and mathematical
 *      alphanumerics into ASCII (４１１１ → 4111, 𝐩𝐚𝐬𝐬 → pass);
 *   4. maps the confusables NFKC does NOT fold — Cyrillic and Greek letters
 *      that are drawn like Latin ones (раssword with a Cyrillic а and р);
 *   5. collapses every run of whitespace to ONE character — a newline when
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
 * span still indexes the RAW output the caller sent — the evidence contract
 * ("spans are offsets into the raw text") is what makes redaction and the
 * transforms measurement correct, and normalising without a map would
 * quietly break it.
 */

/**
 * Combining accents used on Latin script: Combining Diacritical Marks and
 * their extended, supplement, for-symbols and half-mark blocks. Stripped
 * after a decomposition, so a precomposed "í" and "i" + U+0301 both fold
 * to "i". Other scripts' combining marks are deliberately absent.
 */
const LATIN_ACCENTS = /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/g;

/** `cluster` without Latin accents, or `cluster` itself when it carries none. */
function stripLatinAccents(cluster: string): string {
  const decomposed = cluster.normalize('NFKD');
  const stripped = decomposed.replace(LATIN_ACCENTS, '');
  return stripped === decomposed ? cluster : stripped;
}

/*
 * Characters that are invisible and carry no text: pure evasion when one sits
 * inside a token. This was a list of eight, and everything outside it walked
 * through — a right-to-left override, an invisible separator, a variation
 * selector or a tag character inside a Social Security number defeated
 * no_pii. It is now the Unicode property the eight were instances of:
 * General Category Cf (format), plus the variation selectors, which are
 * combining marks by category and invisible in exactly the same way.
 */
const INVISIBLE = /^[\p{Cf}\uFE00-\uFE0F\u{E0100}-\u{E01EF}]$/u;
/** Whether `ch` (one code point) is dropped. Nothing below the soft hyphen is, so ordinary text never reaches the property test. */
function isInvisible(ch: string): boolean {
  return ch.charCodeAt(0) >= 0xad && INVISIBLE.test(ch);
}

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
   *
   * Built on first read. A rule asks for it only when a pattern actually
   * fires, and on a one-megabyte output the array is four megabytes — so
   * the overwhelming majority of evaluations, which find nothing, never
   * allocate it.
   */
  readonly map: Int32Array;
  /**
   * True when the fold changed nothing AND the map is the identity, so a
   * caller can use normalised offsets as raw offsets directly.
   */
  unchanged: boolean;
  /**
   * Where `dropInsertedBreaks` removed a lone break from inside a token:
   * the index in `text` the break would sit at, and its raw offset. Empty
   * without the option, and when nothing was dropped. wordReading() puts
   * them back.
   */
  readonly joins: ReadonlyArray<{ at: number; raw: number }>;
}

/**
 * Printable ASCII plus the newline. Nothing in that set folds, so the only
 * thing that could change such a string is a whitespace RUN — which makes
 * two linear scans a complete test for "this text is already normalised".
 *
 * This is the hot path and it is why the pass is affordable. Ordinary agent
 * output is plain text; a one-megabyte payload of it used to cost a grapheme
 * segmentation and a character-by-character rebuild, and the hostile-payload
 * budget in the test battery caught exactly that.
 */
const PLAIN_TEXT = /^[\x20-\x7E\n]*$/;
const WHITESPACE_RUN = /\s\s/;
const NO_JOINS: ReadonlyArray<{ at: number; raw: number }> = Object.freeze([]);

/** The result for text that is already in normal form: no copy, no map until asked. */
function identity(raw: string): Normalised {
  let cached: Int32Array | undefined;
  return {
    text: raw,
    unchanged: true,
    joins: NO_JOINS,
    get map(): Int32Array {
      if (cached === undefined) {
        cached = new Int32Array(raw.length + 1);
        for (let i = 0; i <= raw.length; i++) cached[i] = i;
      }
      return cached;
    },
  };
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

/**
 * A lone line break or tab with a token on both sides (see insideToken): the
 * one shape the plain-text fast path must not wave through, because it is the
 * evasion the pass exists to fold.
 */
const TOKEN_BREAK = /(?:\p{N}[\n\t][-._@/:+\p{N}]|[-._@/:+][\n\t]\p{N}|\p{L}[\n\t]\p{Ll}|\p{Lu}[\n\t]\p{Lu}\p{Lu})/u;
/** The punctuation a number or an identifier carries between its digits: 123-45-6789, 4111 1111, a@b.c, AKIA…/…. */
const TOKEN_PUNCT = /[-._@/:+]/;
/**
 * Whether a character inserted between `prev` and `next` sits inside one
 * token rather than between two. Inside a number or an identifier (a digit
 * on either side of the punctuation it carries) it always is. Between two
 * letters it is when the next letter is lowercase — a word continuing
 * (previ|ous), or a capital run continuing on both sides (AKIAIOSF|ODNN…);
 * a lone capital or a digit after the break may start a line or a column
 * ("done" then "System:"), and line structure is meaning the injection
 * rule reads, so that break stays.
 */
function insideToken(prev: string, next: string): boolean {
  const p = prev.slice(-1);
  const n = next.slice(0, 1);
  const digit = /\p{N}/u;
  if (digit.test(p) && digit.test(n)) return true;
  if ((digit.test(p) && TOKEN_PUNCT.test(n)) || (TOKEN_PUNCT.test(p) && digit.test(n))) return true;
  if (/\p{L}/u.test(p) && /\p{Ll}/u.test(n)) return true;
  // A capital run continuing (AKIAIOSF|ODNN…): a capital on both sides and another after — not a new line's first word.
  return /\p{Lu}/u.test(p) && /^\p{Lu}\p{Lu}/u.test(next);
}
const WHITESPACE = /\s/u;
const LINE_BREAK = /[\n\r\u2028\u2029]/u;

/** Folds `raw` for matching and returns the offset map that puts evidence back on the raw text. */
export interface NormaliseOptions {
  /**
   * Drop a lone tab or line break inserted inside a token (see insideToken)
   * instead of folding it to whitespace. The PATTERN rules ask for this —
   * no_pii, no_blocklist_words, no_injection_patterns, no_injection_compliance —
   * because the thing they match is one token an evader splits. Rules that
   * compare TOKENS between texts (grounded_in_reads) must not: joining two
   * hard-wrapped words in a file the agent read, but not in the answer that
   * cites them, turns a grounded citation into a miss (measured: precision
   * 100% → 80% when this was applied to every rule). Default off.
   */
  dropInsertedBreaks?: boolean;
}

export function normalise(raw: string, options: NormaliseOptions = {}): Normalised {
  const dropBreaks = options.dropInsertedBreaks === true;
  // Already in normal form: two linear scans and no allocation at all.
  if (PLAIN_TEXT.test(raw) && !WHITESPACE_RUN.test(raw) && !(dropBreaks && TOKEN_BREAK.test(raw))) return identity(raw);

  const out: string[] = [];
  const offsets: number[] = [];
  /** The whitespace run being accumulated: where it started and ended, and whether it broke a line. */
  let run: { at: number; end: number; hadBreak: boolean } | null = null;
  const joins: Array<{ at: number; raw: number }> = [];
  let changed = false;
  /** False as soon as one output character does not sit at its own raw offset. */
  let identityMap = true;

  const push = (chars: string, at: number): void => {
    for (const ch of chars) {
      if (at !== out.length) identityMap = false;
      out.push(ch);
      offsets.push(at);
    }
  };

  /**
   * Emits the pending whitespace run as one character: a newline if it broke
   * a line, else a space — unless the run is ONE character that is not a
   * space, sitting between two characters of one token (a letter or digit on
   * both sides, or a digit against the punctuation a number carries). That is
   * not whitespace; it is a tab or a line break inserted inside a word, an
   * SSN or a key so the pattern will not match — the two evasions the
   * transforms table measured at 38–53% recall — and it is
   * dropped like a zero-width space, the offset map still indexing the raw
   * text. A run that contains a real space, or sits between words, is
   * whitespace and folds as before.
   */
  const flushRun = (next?: string): void => {
    if (run === null) return;
    if (dropBreaks && run.end - run.at === 1 && next !== undefined && out.length > 0) {
      const inserted = raw.slice(run.at, run.end);
      const prev = out[out.length - 1];
      if (inserted !== ' ' && insideToken(prev, next)) {
        joins.push({ at: out.length, raw: run.at });
        changed = true;
        run = null;
        return;
      }
    }
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
    if (cluster.length > 1 || isInvisible(cluster)) {
      let stripped = '';
      for (const ch of cluster) if (!isInvisible(ch)) stripped += ch;
      if (stripped !== cluster) {
        changed = true;
        cluster = stripped;
      }
    }
    if (cluster === '') return;
    if (WHITESPACE.test(cluster)) {
      const hadBreak = LINE_BREAK.test(cluster);
      if (run === null) run = { at: index, end: index + rawCluster.length, hadBreak };
      else {
        run.end = index + rawCluster.length;
        run.hadBreak ||= hadBreak;
        changed = true;
      }
      return;
    }
    flushRun(raw.slice(index, index + 2));
    let folded = stripLatinAccents(cluster).normalize('NFKC');
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

  const text = out.join('');
  let cached: Int32Array | undefined;
  return {
    text,
    unchanged: !changed && identityMap && text.length === raw.length,
    joins,
    get map(): Int32Array {
      if (cached === undefined) {
        cached = new Int32Array(offsets.length + 1);
        cached.set(offsets);
        cached[offsets.length] = raw.length;
      }
      return cached;
    },
  };
}

/**
 * The same text read as WORDS: every break the token reading dropped is put
 * back as a space, and every line break reads as a space.
 *
 * `dropInsertedBreaks` answers an ambiguous question one way. A lone tab or
 * line break between two letters is either an evasion splitting a word
 * (previ|ous) or an ordinary separator between two (ignore|all), and the
 * option always reads it as the first. That glued real words together:
 * an injection written one word per line, with tabs, or with no-break spaces
 * for spaces became one unbroken string no phrase could match, and so did a
 * blocked phrase and a seed phrase listed down the page. A rule that matches
 * PHRASES therefore reads the text both ways — this reading beside the one it
 * came from — and neither reading is asked to be right about every break.
 *
 * Null when the two readings are the same text (nothing was joined and no
 * line break is left), so the ordinary single-line output pays nothing. The
 * map is this reading's own: a span found here still indexes the raw text.
 * Line-shaped detectors must not use it; a forged `System:` line is a line.
 */
export function wordReading(n: Normalised): Normalised | null {
  const joins = n.joins;
  if (joins.length === 0) {
    if (!n.text.includes('\n')) return null;
    // Length-preserving: a newline is one character and so is the space that replaces it.
    return {
      text: n.text.replace(/\n/g, ' '),
      unchanged: false,
      joins: NO_JOINS,
      get map(): Int32Array {
        return n.map;
      },
    };
  }
  const parts: string[] = [];
  let from = 0;
  for (const join of joins) {
    parts.push(n.text.slice(from, join.at), ' ');
    from = join.at;
  }
  parts.push(n.text.slice(from));
  const text = parts.join('').replace(/\n/g, ' ');
  let cached: Int32Array | undefined;
  return {
    text,
    unchanged: false,
    joins: NO_JOINS,
    get map(): Int32Array {
      if (cached === undefined) {
        const source = n.map;
        cached = new Int32Array(text.length + 1);
        let write = 0;
        let next = 0;
        for (let read = 0; read <= n.text.length; read++) {
          while (next < joins.length && joins[next].at === read) {
            cached[write++] = joins[next].raw;
            next += 1;
          }
          cached[write++] = source[read];
        }
      }
      return cached;
    },
  };
}

/**
 * A span in normalised coordinates as a span in raw coordinates. Always
 * widens rather than narrows: when characters were dropped between the last
 * matched character and the next kept one, the raw span covers them, which
 * is what a reader wants — the evasion is part of the evidence.
 */
export function toRawSpan(n: Normalised, start: number, end: number): [number, number] {
  // The identity case never touches the map, so no array is built for the
  // ordinary text that makes up almost every evaluation.
  if (n.unchanged) return [Math.max(0, start), Math.max(start, end)];
  const s = Math.max(0, Math.min(start, n.map.length - 1));
  const e = Math.max(s, Math.min(end, n.map.length - 1));
  return [n.map[s], n.map[e]];
}

