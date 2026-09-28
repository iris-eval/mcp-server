/*
 * Full-text search over traces: the query language, and the snippet.
 *
 * What a caller types is never handed to SQLite. FTS5 has its own query
 * syntax — AND, OR, NOT, NEAR(), parentheses, `col:` filters, `^`, `+`,
 * `*` — and a raw user string passed to MATCH is both an injection surface
 * (`input:` would scope the search to a column the caller did not choose)
 * and a crash (`"`, `(`, `NEAR(` are syntax errors). The query is parsed
 * here into terms instead, each term is reduced to the tokens the index
 * holds, and every term goes to MATCH as a double-quoted string of those
 * tokens, which never hold a quote. Nothing the caller typed reaches the
 * FTS5 parser as syntax, so no input can error it or widen it.
 *
 * The language is three rules, the ones a search box already implies:
 *   - every word must appear (in any of the searched fields), in any order;
 *   - "a quoted phrase" must appear as those words in that order;
 *   - a word ending in `*` matches any word it starts (`refund*` finds
 *     refunded, refunds).
 * Matching ignores case and accents (`cafe` finds café). Punctuation
 * separates words and is not itself searchable: `get_weather` is the
 * phrase "get weather", which is how the index stored it.
 *
 * The tokenizer below is the index's (`unicode61 remove_diacritics 2`),
 * code point for code point: it reads a table generated from SQLite's own
 * tokenizer (unicode61.generated.ts), so the same function decides what a
 * query term is, which stored words a snippet highlights, and — when SQLite
 * has no FTS5 — which traces match, and none of them can disagree with the
 * index. (It used to approximate unicode61 with Unicode categories and NFD,
 * which split Korean syllables into letters: a Korean word searched with
 * the index found nothing.)
 */

import type { SpanTextPart } from './search-index.js';
import { UNICODE61 } from './unicode61.generated.js';

/** The five fields a search reads, in the order a snippet prefers them on a tie. */
export const SEARCH_FIELDS = ['output', 'input', 'tool_calls', 'spans', 'metadata'] as const;
export type SearchField = (typeof SEARCH_FIELDS)[number];

/** Longest query accepted, in characters. */
export const SEARCH_MAX_LENGTH = 500;

/*
 * What one query may cost (#703). A term costs a read of every place its
 * word occurs; a prefix term costs that for every word it starts, merged
 * before the first result, and nothing can interrupt that merge. `w*` in a
 * store where most words start with w merged nearly the whole index, and
 * the same term repeated 32 times did it 32 times: 47 s on 10,000 traces,
 * with every other request waiting. So a query is normalised first
 * (normaliseTerms: a repeat, or a prefix another term implies, is searched
 * once and reported as ignored), and then refused if it is still over one of
 * the limits below (searchRefusal). Whatever passes also runs under a time
 * budget (the adapter's searchBudgetMs).
 */
/** Most terms one query may carry, after repeats are merged; a query with more is refused, never cut. */
export const SEARCH_MAX_TERMS = 16;
/** Most prefix terms (`word*`) one query may carry. */
export const SEARCH_MAX_PREFIXES = 4;
/**
 * Fewest characters before a `*`. A one- or two-letter prefix starts most
 * of the words in a store (measured in the changelog), so it narrows
 * nothing and costs a merge of all of them. A word with Chinese, Japanese or
 * Korean in it needs one character: one CJK character is a word, and it is
 * already searched as the pieces it starts (cjkQuery).
 */
export const SEARCH_MIN_PREFIX_CHARS = 3;

export interface SearchTerm {
  /** Normalised tokens, in order; one for a word, several for a phrase. */
  tokens: string[];
  /** The last token matches any word it starts. */
  prefix: boolean;
}

/** A term the query carried that is not searched, because the terms kept already find exactly what it would. */
export interface IgnoredTerm {
  term: string;
  reason: string;
}

export interface ParsedSearch {
  terms: SearchTerm[];
  /** Terms left out by normaliseTerms, each once. */
  ignored?: IgnoredTerm[];
  /** Prefix terms typed with too few characters (searchRefusal refuses them), each once, including any normaliseTerms left out. */
  shortPrefixes?: string[];
}

export interface MatchFragment {
  text: string;
  hit: boolean;
}

/** Where a trace matched, and the words around it. */
export interface TraceMatch {
  field: SearchField;
  /** Plain text; an ellipsis marks a cut. */
  snippet: string;
  /** The same snippet split at the matched words, for highlighting without offsets. */
  fragments: MatchFragment[];
  /** With field `spans`: the span the excerpt comes from. */
  span?: { span_id: string; name: string };
}

interface Token {
  norm: string;
  start: number;
  end: number;
}

const ASCII_ONLY_RE = /^[\x00-\x7f]*$/;

/** What unicode61 does with an ASCII code point: -1 splits a word, else the code point it becomes. */
const ASCII = new Int32Array(128);
const DROPPED = new Set(UNICODE61.dropped);
const FOLDS = new Map(UNICODE61.folds.map(([from, to]) => [from, String.fromCodePoint(to)]));
for (let cp = 0; cp < 128; cp += 1) ASCII[cp] = isSeparatorSlow(cp) ? -1 : FOLDS.has(cp) ? FOLDS.get(cp)!.codePointAt(0)! : cp;

function isSeparatorSlow(cp: number): boolean {
  if (cp === 0) return true;
  const ranges = UNICODE61.separators;
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ranges[mid][0]) hi = mid - 1;
    else if (cp > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Whether unicode61 splits words at this code point. */
export function isSeparator(cp: number): boolean {
  return cp < 128 ? ASCII[cp] === -1 : isSeparatorSlow(cp);
}

/** A word character as unicode61 stores it: folded, or '' for one it drops. */
function foldChar(cp: number): string {
  if (cp < 128) return String.fromCharCode(ASCII[cp]);
  if (DROPPED.has(cp)) return '';
  return FOLDS.get(cp) ?? String.fromCodePoint(cp);
}

/** Text as unicode61 would store its words, separators left in place: for a substring test against a query word. */
export function foldText(text: string): string {
  // ASCII folds by case alone (the table's ASCII folds are A-Z; a test holds it to that).
  if (ASCII_ONLY_RE.test(text)) return text.toLowerCase();
  let out = '';
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    out += isSeparator(cp) ? text.slice(i, i + width) : foldChar(cp);
    i += width;
  }
  return out;
}

/** The words of a text as the index sees them, with their offsets in the original string. */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let norm = '';
  let start = -1;
  let end = -1;
  const flush = () => {
    if (norm.length > 0) out.push({ norm, start, end });
    norm = '';
    start = -1;
  };
  for (let i = 0; i < text.length; ) {
    const code = text.charCodeAt(i);
    if (code < 128) {
      const to = ASCII[code];
      if (to === -1) flush();
      else {
        if (start < 0) start = i;
        norm += String.fromCharCode(to);
        end = i + 1;
      }
      i += 1;
      continue;
    }
    const cp = text.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    if (isSeparatorSlow(cp)) flush();
    else {
      if (start < 0) start = i;
      norm += foldChar(cp);
      end = i + width;
    }
    i += width;
  }
  flush();
  return out;
}

/**
 * Split what the caller typed into terms. Never throws: an unbalanced quote
 * closes at the end of the input, a `*` with nothing before it is dropped,
 * and a chunk with no letter or digit in it is not a term.
 */
export function parseSearch(raw: string): ParsedSearch {
  return normaliseTerms(splitTerms(raw));
}

/** The terms as typed, before normaliseTerms: exported for the test that holds normalising to finding the same traces. */
export function splitTerms(raw: string): SearchTerm[] {
  const terms: SearchTerm[] = [];
  const text = raw.slice(0, SEARCH_MAX_LENGTH);
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/u.test(ch)) {
      i += 1;
      continue;
    }
    let chunk: string;
    if (ch === '"') {
      const close = text.indexOf('"', i + 1);
      const end = close === -1 ? text.length : close;
      chunk = text.slice(i + 1, end);
      i = end + 1;
      // A `*` straight after the closing quote makes the phrase's last word a prefix.
      if (text[i] === '*') {
        chunk += '*';
        i += 1;
      }
    } else {
      let end = i;
      while (end < text.length && !/\s/u.test(text[end]) && text[end] !== '"') end += 1;
      chunk = text.slice(i, end);
      i = end;
    }
    const tokens = tokenize(chunk).map((t) => t.norm);
    if (tokens.length === 0) continue;
    // A prefix only when the star sits right after the last word, not after punctuation that follows it.
    const bare = chunk.trimEnd();
    const beforeStars = bare.replace(/\*+$/u, '');
    const lastCp = beforeStars.length < bare.length && beforeStars.length > 0 ? beforeStars.codePointAt(beforeStars.length - (/[\uDC00-\uDFFF]$/u.test(beforeStars) ? 2 : 1))! : -1;
    const prefix = lastCp >= 0 && !isSeparator(lastCp);
    terms.push({ tokens, prefix });
  }
  return terms;
}

/** How a term reads back to the caller: `refund`, `"agent said"`, `refund*`. */
export function describeTerm(term: SearchTerm): string {
  const words = term.tokens.join(' ');
  const shown = term.tokens.length > 1 ? `"${words}"` : words;
  return term.prefix ? `${shown}*` : shown;
}

/**
 * Leave out the terms that cannot change which traces match, so each costs
 * nothing: a repeat of an earlier term, and a one-word prefix that another
 * one-word term implies (`refund` or `refunded*` finds only traces `ref*`
 * finds, so `ref*` adds nothing). Terms with CJK in them are only merged
 * when repeated: a CJK word is searched as its pieces (cjkQuery), and a
 * shorter one is not always a prefix of those. The ranking can change,
 * since each term kept is scored once; the traces matched do not.
 */
export function normaliseTerms(all: SearchTerm[]): ParsedSearch {
  const ignored = new Map<string, string>();
  const seen = new Set<string>();
  const unique: SearchTerm[] = [];
  for (const term of all) {
    const key = describeTerm(term);
    if (seen.has(key)) {
      ignored.set(key, 'repeats an earlier term');
      continue;
    }
    seen.add(key);
    unique.push(term);
  }
  const single = (t: SearchTerm) => t.tokens.length === 1 && !hasCjk(t.tokens[0]);
  const terms = unique.filter((term) => {
    if (!term.prefix || !single(term)) return true;
    const by = unique.find((other) => other !== term && single(other) && other.tokens[0].startsWith(term.tokens[0]) && (other.tokens[0] !== term.tokens[0] || !other.prefix));
    if (by === undefined) return true;
    ignored.set(describeTerm(term), `implied by ${describeTerm(by)}`);
    return false;
  });
  // Judged on what was typed, so the rule reads the same whether or not another term implies the prefix (the dashboard checks it as typed).
  const short = unique.filter(isShortPrefix).map(describeTerm);
  return {
    terms,
    ...(ignored.size > 0 ? { ignored: [...ignored].map(([term, reason]) => ({ term, reason })) } : {}),
    ...(short.length > 0 ? { shortPrefixes: short } : {}),
  };
}

/** A prefix term with fewer than SEARCH_MIN_PREFIX_CHARS characters before its `*`, and no CJK in its last word. */
function isShortPrefix(t: SearchTerm): boolean {
  const last = t.tokens[t.tokens.length - 1];
  return t.prefix && !hasCjk(last) && Array.from(last).length < SEARCH_MIN_PREFIX_CHARS;
}

/**
 * Why this query is refused, or undefined when it may run: a prefix too
 * short to narrow anything, or more terms or prefix terms than one query
 * may carry. Read by both request paths before they search (get_traces,
 * GET /api/v1/traces) and by the adapter itself, so nothing reaches the
 * index over the limits.
 */
export function searchRefusal(parsed: ParsedSearch): string | undefined {
  const short = parsed.shortPrefixes ?? parsed.terms.filter(isShortPrefix).map(describeTerm);
  if (short.length > 0) {
    const shown = short.join(', ');
    return `${shown}: a prefix needs at least ${SEARCH_MIN_PREFIX_CHARS} letters or digits before the * (one is enough for Chinese, Japanese or Korean). A shorter prefix starts most words, so it narrows nothing and makes the search slow: write more of the word, or drop the *`;
  }
  const prefixes = parsed.terms.filter((t) => t.prefix).length;
  if (prefixes > SEARCH_MAX_PREFIXES) {
    return `${prefixes} prefix terms (word*): a search takes at most ${SEARCH_MAX_PREFIXES}, because each one reads every word it starts. Write some of them out in full`;
  }
  if (parsed.terms.length > SEARCH_MAX_TERMS) {
    return `${parsed.terms.length} terms: a search takes at most ${SEARCH_MAX_TERMS} (a "quoted phrase" is one term). Every word must match, so the first few already narrow it`;
  }
  return undefined;
}

/**
 * The MATCH expression for parsed terms. A token never holds a double quote
 * (unicode61 splits words at it, which the table's generator checks), so
 * each quoted string below is one FTS5 string: whatever else it holds —
 * operators, column names, `*` — is text inside it, never syntax.
 */
export function toFtsQuery(parsed: ParsedSearch): string {
  return parsed.terms.map((t) => `"${t.tokens.join(' ')}"${t.prefix ? '*' : ''}`).join(' AND ');
}

function tokenMatches(term: SearchTerm, index: number, token: string): boolean {
  const want = term.tokens[index];
  const last = index === term.tokens.length - 1;
  return last && term.prefix ? token.startsWith(want) : token === want;
}

/** Every position in `tokens` where `term` starts. */
function termHits(tokens: Token[], term: SearchTerm): number[] {
  const hits: number[] = [];
  const n = term.tokens.length;
  for (let i = 0; i + n <= tokens.length; i += 1) {
    let ok = true;
    for (let j = 0; j < n; j += 1) {
      if (!tokenMatches(term, j, tokens[i + j].norm)) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/*
 * Chinese, Japanese and Korean (#682). unicode61 keeps a run of CJK
 * characters as one word, and Chinese and Japanese put no spaces between
 * words, so `退款已经批准了` is a single word and `批准` inside it matched
 * nothing. A field that holds CJK text is also indexed as a stream (the
 * trace_search_cjk table, search-index.ts) where every word with CJK in it
 * becomes its pieces:
 *
 *   - each run of CJK characters as its overlapping two-character bigrams
 *     (`退款已经` → `退款 款已 已经`), and the run's last character in a
 *     separate `uni` stream;
 *   - Latin letters or digits written against CJK as a word of their own
 *     (`iPhone充电器` → `iphone 充电 电器`);
 *   - the words either side of a word with CJK in it, as they are, so a
 *     phrase that mixes CJK and other words still reads in order; where
 *     other words are left out, a gap mark, so a phrase cannot read across
 *     them. The rest of the field is in the main index already.
 *
 * A query word with CJK in it is cut the same way and searched as the phrase
 * of its pieces, so `批准` finds the bigram `批准` inside any run and
 * `退款已经` the three bigrams in a row: a match anywhere in a run, in
 * order. A single CJK character matches a bigram it starts or a run's last
 * character (`uni`), so it is found wherever it stands. One function
 * (cjkStream) makes the stream for the index, the search without FTS5 and
 * the snippet, and cjkPhrase the query side, so they agree by construction.
 * A field without CJK has no stream and costs nothing.
 */

// Han, kana and Hangul, and the two marks that live inside Japanese words: 々 (repetition) and ー (long vowel).
const CJK_RE = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\u3005\u30fc]/u;

/** Whether a text holds any CJK character. */
export function hasCjk(text: string): boolean {
  return CJK_RE.test(text);
}

/** One piece of a CJK stream, with where it is in the field's text; `firstEnd` is the end of its first character. */
export interface StreamToken {
  norm: string;
  start: number;
  end: number;
  firstEnd: number;
}

export interface CjkStream {
  bi: StreamToken[];
  uni: StreamToken[];
}

interface Char {
  ch: string;
  start: number;
  end: number;
}

/** A word's characters as the index stores them, each with where it is in the text. */
function wordChars(text: string, token: Token): Char[] {
  const out: Char[] = [];
  for (let i = token.start; i < token.end; ) {
    const cp = text.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    const ch = foldChar(cp);
    if (ch.length > 0) out.push({ ch, start: i, end: i + width });
    i += width;
  }
  return out;
}

/** The pieces of one word with CJK in it: runs of CJK as bigrams (their last character to `uni`), other runs as words. */
function piecesOf(chars: Char[], bi: StreamToken[], uni: StreamToken[]): void {
  let i = 0;
  while (i < chars.length) {
    const cjk = CJK_RE.test(chars[i].ch);
    let j = i;
    while (j < chars.length && CJK_RE.test(chars[j].ch) === cjk) j += 1;
    const run = chars.slice(i, j);
    if (!cjk || run.length === 1) {
      bi.push({ norm: run.map((c) => c.ch).join(''), start: run[0].start, end: run[run.length - 1].end, firstEnd: run[0].end });
    } else {
      for (let k = 0; k + 1 < run.length; k += 1) bi.push({ norm: run[k].ch + run[k + 1].ch, start: run[k].start, end: run[k + 1].end, firstEnd: run[k].end });
    }
    if (cjk) {
      const last = run[run.length - 1];
      uni.push({ norm: last.ch, start: last.start, end: last.end, firstEnd: last.end });
    }
    i = j;
  }
}

/** The CJK stream of a field's text, or undefined when it holds no CJK. */
export function cjkStream(text: string, tokens: Token[] = tokenize(text)): CjkStream | undefined {
  if (!hasCjk(text)) return undefined;
  const bi: StreamToken[] = [];
  const uni: StreamToken[] = [];
  const cjk = tokens.map((t) => hasCjk(t.norm));
  let skipped = false;
  tokens.forEach((token, i) => {
    const carried = cjk[i] || cjk[i - 1] === true || cjk[i + 1] === true;
    if (!carried) {
      skipped = true;
      return;
    }
    // Words were left out since the last piece: mark the gap, so a phrase cannot read across it.
    if (skipped && bi.length > 0) bi.push({ norm: STREAM_GAP, start: token.start, end: token.start, firstEnd: token.start });
    skipped = false;
    if (cjk[i]) piecesOf(wordChars(text, token), bi, uni);
    else bi.push({ ...token, firstEnd: token.end });
  });
  return { bi, uni };
}

/** Stands in the stream for words left out of it: a private-use character, which no query word holds. */
const STREAM_GAP = '\uE000';

/** A stream as the index column holds it. */
export function streamText(tokens: StreamToken[]): string {
  return tokens.map((t) => t.norm).join(' ');
}

/** How a term reads in the CJK stream: one CJK character, or a phrase of pieces (the last a prefix when the term is). */
export type CjkQuery = { char: string } | { pieces: string[]; prefix: boolean };

export function cjkQuery(term: SearchTerm): CjkQuery {
  if (term.tokens.length === 1) {
    const chars = Array.from(term.tokens[0]);
    if (chars.length === 1 && CJK_RE.test(chars[0])) return { char: chars[0] };
  }
  const pieces: string[] = [];
  for (const word of term.tokens) {
    if (!hasCjk(word)) {
      pieces.push(word);
      continue;
    }
    const bi: StreamToken[] = [];
    piecesOf(
      Array.from(word).map((ch) => ({ ch, start: 0, end: 0 })),
      bi,
      [],
    );
    pieces.push(...bi.map((t) => t.norm));
  }
  return { pieces, prefix: term.prefix };
}

/** The CJK stream's columns, the ones a term's pieces are searched in (`uni` apart). */
const CJK_STREAM_COLUMNS = '{input output tool_calls metadata spans}';

/**
 * The MATCH expression for one term in the CJK table: its pieces as a
 * phrase in the stream columns, or a single CJK character as a bigram it
 * starts or a run's last character. As in toFtsQuery, every piece is a
 * quoted string, so nothing in it is syntax.
 */
export function toCjkFtsQuery(term: SearchTerm): string {
  const q = cjkQuery(term);
  if ('char' in q) return `(${CJK_STREAM_COLUMNS} : "${q.char}"*) OR (uni : "${q.char}")`;
  return `${CJK_STREAM_COLUMNS} : "${q.pieces.join(' ')}"${q.prefix ? '*' : ''}`;
}

/** Whether a stored string could hold CJK: it does, or it has a \u escape (a JSON string inside it may spell CJK that way). */
export function mayHoldCjk(text: string | null | undefined): boolean {
  return typeof text === 'string' && ((CJK_BLOCKS_RE.test(text) && hasCjk(text)) || text.includes('\\u'));
}
/**
 * The blocks CJK lives in (Hangul Jamo; radicals through Hangul syllables;
 * compatibility ideographs through half-width forms; any character past the
 * BMP), as plain ranges: about a tenth of hasCjk's cost on text with accents,
 * which the insert path tests every trace for. hasCjk then decides.
 */
const CJK_BLOCKS_RE = /[ᄀ-ᇿ⺀-퟿豈-￯\ud800-\udbff]/;


/** Every stretch of the field's text where `term` matches in its CJK stream, as [start, end] offsets. */
function cjkHits(stream: CjkStream, term: SearchTerm): Array<[number, number]> {
  const q = cjkQuery(term);
  const out: Array<[number, number]> = [];
  if ('char' in q) {
    for (const t of stream.bi) if (t.norm.startsWith(q.char)) out.push([t.start, t.firstEnd]);
    for (const t of stream.uni) if (t.norm === q.char) out.push([t.start, t.end]);
    return out;
  }
  const n = q.pieces.length;
  for (let i = 0; i + n <= stream.bi.length; i += 1) {
    let ok = true;
    for (let j = 0; j < n && ok; j += 1) {
      const have = stream.bi[i + j].norm;
      ok = j === n - 1 && q.prefix ? have.startsWith(q.pieces[j]) : have === q.pieces[j];
    }
    if (ok) out.push([stream.bi[i].start, stream.bi[i + n - 1].end]);
  }
  return out;
}

/**
 * Every stretch of a field where `term` matches, as [start, end] offsets:
 * its words in order, and in the field's CJK stream when it has one. The
 * same stretch found both ways counts once.
 */
function fieldHits(tokens: Token[], stream: CjkStream | undefined, term: SearchTerm): Array<[number, number]> {
  const n = term.tokens.length;
  const hits = termHits(tokens, term).map((at): [number, number] => [tokens[at].start, tokens[at + n - 1].end]);
  if (!stream) return hits;
  const seen = new Set(hits.map(([a, b]) => `${a}:${b}`));
  for (const hit of cjkHits(stream, term)) {
    const key = `${hit[0]}:${hit[1]}`;
    if (!seen.has(key)) {
      seen.add(key);
      hits.push(hit);
    }
  }
  return hits;
}

/**
 * The text a search reads from each field of a trace: tool calls and
 * metadata by their values, not their keys; `spans` is the trace's span
 * text as the index holds it (readSpanText, search-index.ts).
 */
export function searchableText(trace: { input?: unknown; output?: unknown; tool_calls?: unknown; metadata?: unknown }, spans = ''): Record<SearchField, string> {
  return {
    input: typeof trace.input === 'string' ? trace.input : '',
    output: typeof trace.output === 'string' ? trace.output : '',
    tool_calls: leafValues(trace.tool_calls).join(' · '),
    spans,
    metadata: leafValues(trace.metadata).join(' · '),
  };
}

/** String and number leaves of a JSON value, depth first — what the index's json_tree reads. */
function leafValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (typeof value === 'number' && Number.isFinite(value)) out.push(String(value));
  else if (Array.isArray(value)) for (const v of value) leafValues(v, out);
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) leafValues(v, out);
  return out;
}

/**
 * Whether a trace's span text could hold the terms its own fields lack,
 * judged from the JSON its spans are stored as, before the costly walk that
 * extracts the text (the search without FTS5 runs this on every trace its
 * own fields do not match). A word of the span text is a stretch of the
 * stored JSON once accents and case are removed, so a term whose words are
 * not all in it cannot be there: false only when that is certain. JSON can
 * spell a letter as a \u escape, so raw JSON holding one always may.
 */
export function spansMayMatch(fields: Record<SearchField, string>, parsed: ParsedSearch, rawSpans: string): boolean {
  if (rawSpans.includes('\\u')) return true;
  const raw = foldText(rawSpans);
  const own = SEARCH_FIELDS.filter((f) => f !== 'spans').map((f) => tokenize(fields[f]));
  for (const term of parsed.terms) {
    if (own.some((tokens) => termHits(tokens, term).length > 0)) continue;
    if (!term.tokens.every((t) => raw.includes(t))) return false;
  }
  return true;
}

/**
 * Whether a trace matches: every term appears in at least one field. The
 * FTS5 index answers this in SQL; this is the same test for a SQLite built
 * without FTS5, and what the snippet uses to find the hits.
 */
export function matchesTrace(fields: Record<SearchField, string>, parsed: ParsedSearch): { matched: boolean; hits: number } {
  if (parsed.terms.length === 0) return { matched: false, hits: 0 };
  const byField = SEARCH_FIELDS.map((f) => ({ text: fields[f], tokens: tokenize(fields[f]), stream: undefined as CjkStream | undefined | null }));
  // A field's CJK stream is built only when a term needs it: one with CJK in it, or one its words alone do not hold.
  const streamOf = (f: (typeof byField)[number]) => {
    if (f.stream === undefined) f.stream = cjkStream(f.text, f.tokens) ?? null;
    return f.stream ?? undefined;
  };
  let hits = 0;
  for (const term of parsed.terms) {
    let found = 0;
    const needsStream = term.tokens.some(hasCjk);
    for (const f of byField) found += needsStream ? fieldHits(f.tokens, streamOf(f), term).length : termHits(f.tokens, term).length;
    // A word without CJK is in a stream only as it is in the text: build the stream only for a field whose text holds each of its words.
    if (found === 0 && !needsStream) {
      for (const f of byField) {
        if (!hasCjk(f.text)) continue;
        const folded = foldText(f.text);
        if (term.tokens.every((t) => folded.includes(t))) found += fieldHits(f.tokens, streamOf(f), term).length;
      }
    }
    if (found === 0) return { matched: false, hits: 0 };
    hits += found;
  }
  return { matched: true, hits };
}

/** Words either side of the hits a snippet keeps. */
const SNIPPET_WORDS = 24;
/** Words before the first hit a snippet starts with. */
const SNIPPET_LEAD = 3;
const ELLIPSIS = '…';

/**
 * The excerpt shown with a result: the field with the most distinct terms
 * matched (output first on a tie — "the run where the agent said X"), the
 * window of words that covers the most of them, and the matched words
 * marked. Returns undefined when no field holds a term. With `spanParts`
 * (readSpanText's), an excerpt from `spans` names the span its first
 * matched word is in.
 */
export function buildMatch(fields: Record<SearchField, string>, parsed: ParsedSearch, windowWords = SNIPPET_WORDS, spanParts: readonly SpanTextPart[] = []): TraceMatch | undefined {
  // [start offset, end offset, term index] for every hit: a stretch of words, or of characters inside a CJK word.
  let best: { field: SearchField; tokens: Token[]; hits: Array<[number, number, number]>; distinct: number } | undefined;
  for (const field of SEARCH_FIELDS) {
    const text = fields[field];
    const tokens = tokenize(text);
    if (tokens.length === 0) continue;
    const stream = cjkStream(text, tokens);
    const hits: Array<[number, number, number]> = [];
    parsed.terms.forEach((term, ti) => {
      for (const [a, b] of fieldHits(tokens, stream, term)) hits.push([a, b, ti]);
    });
    if (hits.length === 0) continue;
    const distinct = new Set(hits.map((h) => h[2])).size;
    if (!best || distinct > best.distinct) best = { field, tokens, hits, distinct };
  }
  if (!best) return undefined;

  const { field, tokens, hits } = best;
  const text = fields[field];
  // The word each hit starts and ends in.
  const wordAt = (offset: number): number => {
    let lo = 0;
    let hi = tokens.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tokens[mid].start <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const spans = hits.map(([a, b, ti]) => ({ a, b, ti, first: wordAt(a), last: wordAt(b - 1) })).sort((x, y) => x.a - y.a || x.b - y.b);

  // The window start that covers the most distinct terms, then the most hits; the earliest wins a tie.
  let start = 0;
  let bestScore = -1;
  // Three words of lead-in: a reader shown only the start of the excerpt (the dashboard clamps it to two lines) still sees the match.
  for (const { first } of spans) {
    const from = Math.max(0, first - SNIPPET_LEAD);
    const to = from + windowWords - 1;
    const inside = spans.filter((h) => h.first >= from && h.last <= to);
    const score = new Set(inside.map((h) => h.ti)).size * 1000 + inside.length;
    if (score > bestScore) {
      bestScore = score;
      start = from;
    }
  }
  const end = Math.min(tokens.length - 1, start + windowWords - 1);
  // The marked stretches inside the window, overlapping ones merged (a phrase is one mark, and so are overlapping CJK hits).
  const marks: Array<[number, number]> = [];
  for (const h of spans) {
    if (h.first < start || h.last > end) continue;
    const prev = marks[marks.length - 1];
    if (prev && h.a <= prev[1]) prev[1] = Math.max(prev[1], h.b);
    else marks.push([h.a, h.b]);
  }

  const fragments: MatchFragment[] = [];
  const push = (value: string, hit: boolean) => {
    if (value.length === 0) return;
    const prev = fragments[fragments.length - 1];
    if (prev && prev.hit === hit) prev.text += value;
    else fragments.push({ text: value, hit });
  };
  const clean = (s: string) => s.replace(/\s+/gu, ' ');
  const from = start > 0 ? tokens[start].start : 0;
  const to = end < tokens.length - 1 ? tokens[end].end : text.length;
  if (start > 0) push(ELLIPSIS, false);
  let cursor = from;
  for (const [a, b] of marks) {
    push(clean(text.slice(cursor, a)), false);
    push(clean(text.slice(a, b)), true);
    cursor = b;
  }
  push(clean(text.slice(cursor, to)), false);
  if (end < tokens.length - 1) push(ELLIPSIS, false);

  // Trim the outer whitespace the cut left behind.
  if (fragments.length > 0) {
    fragments[0].text = fragments[0].text.replace(/^\s+/u, '');
    const last = fragments[fragments.length - 1];
    last.text = last.text.replace(/\s+$/u, '');
  }
  const kept = fragments.filter((f) => f.text.length > 0);
  const match: TraceMatch = { field, snippet: kept.map((f) => f.text).join(''), fragments: kept };
  if (field === 'spans') {
    const at = marks.length > 0 ? marks[0][0] : tokens[start].start;
    const part = spanParts.find((p) => at >= p.start && at < p.end);
    if (part) match.span = { span_id: part.span_id, name: part.name };
  }
  return match;
}
