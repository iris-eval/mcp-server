/*
 * The search query language (#7): what a caller types becomes terms, and
 * nothing a caller types reaches FTS5 as syntax.
 *
 * The property tests run arbitrary strings — including every FTS5 operator,
 * quotes, stars, parentheses and column filters — through the parser and
 * then through a real FTS5 MATCH on this cell's driver, and require that no
 * input throws and that the index and the no-FTS5 scan return the same
 * traces for it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildMatch, describeTerm, matchesTrace, parseSearch, searchableText, tokenize, toFtsQuery, SEARCH_MAX_LENGTH } from '../../../src/storage/search.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import type { Trace } from '../../../src/types/trace.js';
import { SEARCH_DRIVER } from './fts5-here.js';

const terms = (q: string) => parseSearch(q).terms.map(describeTerm);

describe('parseSearch', () => {
  it('reads words, "phrases" and word* prefixes, lower-cased and without accents', () => {
    expect(terms('Refund approved')).toEqual(['refund', 'approved']);
    expect(terms('"the agent said" yes')).toEqual(['"the agent said"', 'yes']);
    expect(terms('refund*')).toEqual(['refund*']);
    expect(terms('"agent sa"*')).toEqual(['"agent sa"*']);
    expect(terms('Café NAÏVE')).toEqual(['cafe', 'naive']);
  });

  it('treats punctuation as a word break, the way the index stored the text', () => {
    expect(terms('get_weather')).toEqual(['"get weather"']);
    expect(terms('user@example.com')).toEqual(['"user example com"']);
    expect(terms('input:paris')).toEqual(['"input paris"']);
  });

  it('reads FTS5 operators and syntax as words, never as syntax', () => {
    expect(terms('a OR b')).toEqual(['a', 'or', 'b']);
    expect(terms('NOT secret')).toEqual(['not', 'secret']);
    expect(terms('NEAR(alpha beta, 3)')).toEqual(['"near alpha"', 'beta', '3']);
    expect(terms('(alpha')).toEqual(['alpha']);
    expect(terms('^start +plus -minus')).toEqual(['start', 'plus', 'minus']);
    expect(terms('{input output}: x')).toEqual(['input', 'output', 'x']);
  });

  it('never throws, and a chunk with no letter or digit is not a term', () => {
    expect(terms('')).toEqual([]);
    expect(terms('   ')).toEqual([]);
    expect(terms('*')).toEqual([]);
    expect(terms('"')).toEqual([]);
    expect(terms('""')).toEqual([]);
    expect(terms('" "*')).toEqual([]);
    expect(terms('((( )))')).toEqual([]);
    expect(terms('"unbalanced phrase')).toEqual(['"unbalanced phrase"']);
    expect(terms('a"b')).toEqual(['a', 'b']);
    expect(terms('word *')).toEqual(['word']);
    expect(terms('word.*')).toEqual(['word']);
  });

  it('reads only the first SEARCH_MAX_LENGTH characters', () => {
    const long = `${'a '.repeat(SEARCH_MAX_LENGTH)}tail`;
    expect(terms(long)).not.toContain('tail');
  });

  it('builds a MATCH expression of quoted letters and digits only', () => {
    expect(toFtsQuery(parseSearch('refund* "agent said" x'))).toBe('"refund"* AND "agent said" AND "x"');
    expect(toFtsQuery(parseSearch('he said "don\'t" NEAR(x)'))).toBe('"he" AND "said" AND "don t" AND "near x"');
  });
});

describe('tokenize', () => {
  it('keeps the offsets of each word in the original text', () => {
    const text = 'Héllo, wörld_2!';
    expect(tokenize(text).map((t) => [t.norm, text.slice(t.start, t.end)])).toEqual([
      ['hello', 'Héllo'],
      ['world', 'wörld'],
      ['2', '2'],
    ]);
  });
});

describe('searchableText and matchesTrace', () => {
  it('reads tool calls and metadata by their values, never their keys', () => {
    const fields = searchableText({
      tool_calls: [{ tool_name: 'lookup_order', input: { order_id: 'A-42' }, output: { status: 'shipped', eta_days: 3 } }],
      metadata: { customer: 'Ada', flags: ['vip'] },
    });
    expect(fields.tool_calls).toBe('lookup_order · A-42 · shipped · 3');
    expect(fields.metadata).toBe('Ada · vip');
    expect(matchesTrace(fields, parseSearch('shipped vip')).matched).toBe(true);
    expect(matchesTrace(fields, parseSearch('status')).matched).toBe(false);
    expect(matchesTrace(fields, parseSearch('tool_name')).matched).toBe(false);
  });

  it('needs every term, and counts the hits', () => {
    const fields = searchableText({ input: 'refund refund', output: 'approved' });
    expect(matchesTrace(fields, parseSearch('refund approved'))).toEqual({ matched: true, hits: 3 });
    expect(matchesTrace(fields, parseSearch('refund denied')).matched).toBe(false);
    expect(matchesTrace(fields, parseSearch('')).matched).toBe(false);
  });
});

describe('buildMatch', () => {
  it('prefers the field with the most distinct terms, output first on a tie, and marks the matched words', () => {
    const match = buildMatch(searchableText({ input: 'Was the refund approved?', output: 'Yes, the refund was approved today.' }), parseSearch('refund approved'))!;
    expect(match.field).toBe('output');
    expect(match.snippet).toBe('Yes, the refund was approved today.');
    expect(match.fragments).toEqual([
      { text: 'Yes, the ', hit: false },
      { text: 'refund', hit: true },
      { text: ' was ', hit: false },
      { text: 'approved', hit: true },
      { text: ' today.', hit: false },
    ]);
  });

  it('marks a phrase only where the words are in order, and a prefix on the words it starts', () => {
    const match = buildMatch(searchableText({ output: 'said the agent. The agent said no. Refunded.' }), parseSearch('"agent said" refund*'))!;
    expect(match.fragments.filter((f) => f.hit).map((f) => f.text)).toEqual(['agent said', 'Refunded']);
  });

  it('cuts a long field around the hits and says so with an ellipsis', () => {
    const words = Array.from({ length: 200 }, (_, i) => `w${i}`);
    words[120] = 'needle';
    const match = buildMatch(searchableText({ output: words.join(' ') }), parseSearch('needle'))!;
    expect(match.snippet.startsWith('…')).toBe(true);
    expect(match.snippet.endsWith('…')).toBe(true);
    expect(match.snippet).toContain('needle');
    expect(match.snippet.split(' ').length).toBeLessThanOrEqual(26);
    expect(match.fragments.map((f) => f.text).join('')).toBe(match.snippet);
  });

  it('collapses the whitespace between words and returns undefined when nothing matched', () => {
    expect(buildMatch(searchableText({ output: 'line one\n\n\tline   two' }), parseSearch('two'))!.snippet).toBe('line one line two');
    expect(buildMatch(searchableText({ output: 'nothing here' }), parseSearch('absent'))).toBeUndefined();
  });

  it('never throws and its fragments always rebuild the snippet, for any text and query', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), fc.string({ maxLength: 60 }), (text, q) => {
        const match = buildMatch(searchableText({ output: text }), parseSearch(q));
        if (match) {
          expect(match.fragments.map((f) => f.text).join('')).toBe(match.snippet);
          expect(match.fragments.some((f) => f.hit)).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });
});

/*
 * Against a real index. A small corpus with words that the arbitrary
 * queries below will sometimes hit, so "no crash" is not only ever tested
 * on empty results.
 */
const VOCAB = ['refund', 'approved', 'denied', 'café', 'order', 'near', 'or', 'and', 'not', 'agent', 'said', 'paris', 'x1', 'Ωmega', '42'];
const corpus: Trace[] = Array.from({ length: 60 }, (_, i) => ({
  trace_id: `t-${String(i).padStart(3, '0')}`,
  agent_name: i % 2 ? 'odd' : 'even',
  input: `${VOCAB[i % VOCAB.length]} ${VOCAB[(i * 7) % VOCAB.length]} question ${i}`,
  output: `The agent said ${VOCAB[(i * 3) % VOCAB.length]}, then ${VOCAB[(i * 5) % VOCAB.length]}.`,
  tool_calls: [{ tool_name: 'lookup', input: { q: VOCAB[(i * 11) % VOCAB.length] }, output: `result ${i}` }],
  metadata: { tag: VOCAB[(i * 13) % VOCAB.length] },
  timestamp: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
}));

// Strings built from the characters FTS5 treats as syntax, and words it treats as operators.
const hostile = fc
  .array(
    fc.oneof(
      fc.constantFrom('"', '*', '(', ')', ':', '^', '+', '-', '{', '}', ',', ' ', 'NEAR', 'NEAR(', 'AND', 'OR', 'NOT', 'input:', 'output:', "'", '\\', '\0', '​'),
      fc.constantFrom(...VOCAB),
      fc.string({ maxLength: 6 }),
    ),
    { maxLength: 12 },
  )
  .map((parts) => parts.join(''));

describe('search against a real FTS5 index', () => {
  let indexed: SqliteAdapter;
  let scanned: SqliteAdapter;

  beforeAll(async () => {
    indexed = new SqliteAdapter(':memory:', { driver: SEARCH_DRIVER });
    await indexed.initialize();
    scanned = new SqliteAdapter(':memory:', { driver: SEARCH_DRIVER, fts5: false });
    await scanned.initialize();
    await indexed.insertTraces(LOCAL_TENANT, corpus);
    await scanned.insertTraces(LOCAL_TENANT, corpus);
  });

  afterAll(async () => {
    await indexed.close();
    await scanned.close();
  });

  it('answers every hostile query without throwing, and the index and the scan return the same traces', async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(hostile, fc.string({ maxLength: 40 }), fc.string({ unit: 'binary', maxLength: 20 })).filter((q) => q.trim() !== ''), async (q) => {
        const a = await indexed.queryTraces(LOCAL_TENANT, { search: q, limit: 1000, sort_by: 'timestamp' });
        const b = await scanned.queryTraces(LOCAL_TENANT, { search: q, limit: 1000, sort_by: 'timestamp' });
        expect(a.search?.index).toBe('fts5');
        expect(b.search?.index).toBe('scan');
        expect(a.search?.terms).toEqual(b.search?.terms);
        expect(a.traces.map((t) => t.trace_id)).toEqual(b.traces.map((t) => t.trace_id));
        expect(a.total).toBe(b.total);
        for (const t of a.traces) expect(t.match?.fragments.some((f) => f.hit)).toBe(true);
      }),
      { numRuns: 400 },
    );
  });

  it('a query that is only syntax matches nothing, and says it searched no terms', async () => {
    for (const q of ['*', '"', '()', ':', '^', '"*"', '((( )))', '- + {}']) {
      const r = await indexed.queryTraces(LOCAL_TENANT, { search: q });
      expect(r, q).toMatchObject({ total: 0, traces: [], search: { terms: [], index: 'fts5' } });
    }
  });
});
