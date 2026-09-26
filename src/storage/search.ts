/*
 * Full-text search over traces: the query language, and the snippet.
 *
 * What a caller types is never handed to SQLite. FTS5 has its own query
 * syntax — AND, OR, NOT, NEAR(), parentheses, `col:` filters, `^`, `+`,
 * `*` — and a raw user string passed to MATCH is both an injection surface
 * (`input:` would scope the search to a column the caller did not choose)
 * and a crash (`"`, `(`, `NEAR(` are syntax errors). The query is parsed
 * here into terms instead, each term is reduced to the tokens the index
 * holds, and every term goes to MATCH as a double-quoted string of plain
 * letters and digits. Nothing the caller typed reaches the FTS5 parser as
 * syntax, so no input can error it or widen it.
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
 * The tokenizer below mirrors the index's (`unicode61 remove_diacritics 2`):
 * the same function decides what a query term is, which stored words a
 * snippet highlights, and — when SQLite has no FTS5 — which traces match.
 */

/** The four fields a search reads, in the order a snippet prefers them on a tie. */
export const SEARCH_FIELDS = ['output', 'input', 'tool_calls', 'metadata'] as const;
export type SearchField = (typeof SEARCH_FIELDS)[number];

/** Longest query accepted, in characters. */
export const SEARCH_MAX_LENGTH = 500;
/** Most terms one query may carry; words past it are refused rather than dropped. */
export const SEARCH_MAX_TERMS = 32;

export interface SearchTerm {
  /** Normalised tokens, in order; one for a word, several for a phrase. */
  tokens: string[];
  /** The last token matches any word it starts. */
  prefix: boolean;
}

export interface ParsedSearch {
  terms: SearchTerm[];
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
}

interface Token {
  norm: string;
  start: number;
  end: number;
}

// unicode61's token characters are letters, numbers and private-use code
// points; marks travel inside a word and are stripped with the accents.
const TOKEN_RE = /[\p{L}\p{N}\p{Co}][\p{L}\p{N}\p{Co}\p{M}]*/gu;
const MARKS_RE = /\p{M}+/gu;

function normalise(word: string): string {
  return word.normalize('NFD').replace(MARKS_RE, '').toLowerCase();
}

/** The words of a text as the index sees them, with their offsets in the original string. */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const norm = normalise(m[0]);
    if (norm.length === 0) continue;
    out.push({ norm, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Split what the caller typed into terms. Never throws: an unbalanced quote
 * closes at the end of the input, a `*` with nothing before it is dropped,
 * and a chunk with no letter or digit in it is not a term.
 */
export function parseSearch(raw: string): ParsedSearch {
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
    const prefix = /[\p{L}\p{N}\p{Co}\p{M}]\*+$/u.test(chunk.trimEnd());
    terms.push({ tokens, prefix });
  }
  return { terms };
}

/** How a term reads back to the caller: `refund`, `"agent said"`, `refund*`. */
export function describeTerm(term: SearchTerm): string {
  const words = term.tokens.join(' ');
  const shown = term.tokens.length > 1 ? `"${words}"` : words;
  return term.prefix ? `${shown}*` : shown;
}

/**
 * The MATCH expression for parsed terms. Every token is letters and digits
 * only (the tokenizer guarantees it), so the quoted strings below cannot
 * carry a quote, an operator or a column filter.
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

/** The text a search reads from each field of a trace: tool calls and metadata by their values, not their keys. */
export function searchableText(trace: { input?: unknown; output?: unknown; tool_calls?: unknown; metadata?: unknown }): Record<SearchField, string> {
  return {
    input: typeof trace.input === 'string' ? trace.input : '',
    output: typeof trace.output === 'string' ? trace.output : '',
    tool_calls: leafValues(trace.tool_calls).join(' · '),
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
 * Whether a trace matches: every term appears in at least one field. The
 * FTS5 index answers this in SQL; this is the same test for a SQLite built
 * without FTS5, and what the snippet uses to find the hits.
 */
export function matchesTrace(fields: Record<SearchField, string>, parsed: ParsedSearch): { matched: boolean; hits: number } {
  if (parsed.terms.length === 0) return { matched: false, hits: 0 };
  const tokensByField = SEARCH_FIELDS.map((f) => tokenize(fields[f]));
  let hits = 0;
  for (const term of parsed.terms) {
    let found = 0;
    for (const tokens of tokensByField) found += termHits(tokens, term).length;
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
 * marked. Returns undefined when no field holds a term.
 */
export function buildMatch(fields: Record<SearchField, string>, parsed: ParsedSearch, windowWords = SNIPPET_WORDS): TraceMatch | undefined {
  let best: { field: SearchField; tokens: Token[]; spans: Array<[number, number, number]>; distinct: number } | undefined;
  for (const field of SEARCH_FIELDS) {
    const tokens = tokenize(fields[field]);
    if (tokens.length === 0) continue;
    // [first token, last token, term index] for every hit.
    const spans: Array<[number, number, number]> = [];
    parsed.terms.forEach((term, ti) => {
      for (const at of termHits(tokens, term)) spans.push([at, at + term.tokens.length - 1, ti]);
    });
    if (spans.length === 0) continue;
    const distinct = new Set(spans.map((s) => s[2])).size;
    if (!best || distinct > best.distinct) best = { field, tokens, spans, distinct };
  }
  if (!best) return undefined;

  const { field, tokens, spans } = best;
  const text = fields[field];
  spans.sort((a, b) => a[0] - b[0]);

  // The window start that covers the most distinct terms, then the most hits; the earliest wins a tie.
  let start = 0;
  let bestScore = -1;
  // Three words of lead-in: a reader shown only the start of the excerpt (the dashboard clamps it to two lines) still sees the match.
  for (const [first] of spans) {
    const from = Math.max(0, first - SNIPPET_LEAD);
    const to = from + windowWords - 1;
    const inside = spans.filter((s) => s[0] >= from && s[1] <= to);
    const score = new Set(inside.map((s) => s[2])).size * 1000 + inside.length;
    if (score > bestScore) {
      bestScore = score;
      start = from;
    }
  }
  const end = Math.min(tokens.length - 1, start + windowWords - 1);
  // Matched tokens, and the tokens whose gap before them is inside a phrase (so "agent said" is one mark, not two).
  const marked = new Set<number>();
  const joined = new Set<number>();
  for (const [first, last] of spans) {
    if (first < start || last > end) continue;
    for (let k = first; k <= last; k += 1) {
      marked.add(k);
      if (k > first) joined.add(k);
    }
  }

  const fragments: MatchFragment[] = [];
  const push = (value: string, hit: boolean) => {
    if (value.length === 0) return;
    const prev = fragments[fragments.length - 1];
    if (prev && prev.hit === hit) prev.text += value;
    else fragments.push({ text: value, hit });
  };
  const clean = (s: string) => s.replace(/\s+/gu, ' ');
  if (start > 0) push(ELLIPSIS, false);
  let cursor = start > 0 ? tokens[start].start : 0;
  for (let k = start; k <= end; k += 1) {
    const tok = tokens[k];
    push(clean(text.slice(cursor, tok.start)), joined.has(k));
    push(text.slice(tok.start, tok.end), marked.has(k));
    cursor = tok.end;
  }
  if (end < tokens.length - 1) push(ELLIPSIS, false);
  else push(clean(text.slice(cursor)), false);

  // Trim the outer whitespace the cut left behind.
  if (fragments.length > 0) {
    fragments[0].text = fragments[0].text.replace(/^\s+/u, '');
    const last = fragments[fragments.length - 1];
    last.text = last.text.replace(/\s+$/u, '');
  }
  const kept = fragments.filter((f) => f.text.length > 0);
  return { field, snippet: kept.map((f) => f.text).join(''), fragments: kept };
}
