/*
 * What one search may cost (#703).
 *
 * A search runs on the event loop, and every MCP and HTTP request waits
 * while it does. Before this, a query of the same short prefix repeated
 * (`w* w* w* w*`) made SQLite merge most of the index once per term: 47 s
 * for 32 repeats on 10,000 traces, from one call to get_traces. Three
 * things now bound it, and each is tested here:
 *
 *   - normalising: a repeated term, or a prefix another term implies, is
 *     searched once, which never changes the traces matched;
 *   - refusing: a prefix too short to narrow anything, and more terms or
 *     prefix terms than one query may carry, before anything is read;
 *   - the time budget: a search that reads past it stops, and answers with
 *     the best of the newest matches it read, marked incomplete.
 *
 * The adversarial set is the review's queries and generated ones, on a
 * store shaped like the review's: every word starts with w. Each must be
 * refused or answered within a CPU-time bound (tests/helpers/cpu-time.ts
 * says why CPU time, not the wall clock).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter, SEARCH_BUDGET_MS } from '../../../src/storage/sqlite-adapter.js';
import { pageOf } from '../../../src/storage/search-match.js';
import {
  describeTerm,
  matchesTrace,
  normaliseTerms,
  parseSearch,
  searchableText,
  searchRefusal,
  splitTerms,
  SEARCH_MAX_LENGTH,
  SEARCH_MAX_PREFIXES,
  SEARCH_MAX_TERMS,
  SEARCH_MIN_PREFIX_CHARS,
} from '../../../src/storage/search.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import type { Trace } from '../../../src/types/trace.js';
import { cpuMsAsync } from '../../helpers/cpu-time.js';
import { SEARCH_DRIVER } from './fts5-here.js';

const terms = (q: string) => parseSearch(q).terms.map(describeTerm);

describe('normalising a query', () => {
  it('searches a repeated term once, and says so once', () => {
    expect(parseSearch('refund refund Refund')).toEqual({ terms: [{ tokens: ['refund'], prefix: false }], ignored: [{ term: 'refund', reason: 'repeats an earlier term' }] });
    // A short prefix is refused as typed, even where another term implies it and it would not be searched.
    expect(searchRefusal(parseSearch('refund re*'))).toMatch(/^re\*: a prefix needs/);
    const many = parseSearch(Array(32).fill('refund*').join(' '));
    expect(many.terms.map(describeTerm)).toEqual(['refund*']);
    expect(many.ignored).toEqual([{ term: 'refund*', reason: 'repeats an earlier term' }]);
  });

  it('leaves out a one-word prefix another one-word term implies, and keeps the narrower', () => {
    expect(terms('ref* refund')).toEqual(['refund']);
    expect(terms('refund* refund')).toEqual(['refund']);
    expect(terms('con* cont* conta*')).toEqual(['conta*']);
    expect(parseSearch('ref* refunded*').ignored).toEqual([{ term: 'ref*', reason: 'implied by refunded*' }]);
    // A phrase is never the one left out, and never implies: its words must be in order, a stronger test.
    expect(terms('"refund approved" ref*')).toEqual(['"refund approved"', 'ref*']);
    expect(terms('refund "ref approved"*')).toEqual(['refund', '"ref approved"*']);
    // Different words stay.
    expect(terms('refund* approved*')).toEqual(['refund*', 'approved*']);
  });

  it('merges CJK terms only when they repeat: a CJK word is searched as its pieces, and a shorter one is not always a prefix of them', () => {
    expect(terms('批* 批准')).toEqual(['批*', '批准']);
    expect(terms('批准 批准')).toEqual(['批准']);
  });

  it('never changes which traces match: for any query, each trace matches the normalised terms exactly when it matches every term typed', () => {
    const vocab = ['refund', 'refunded', 'ref', 'approved', 'approve', 'app', 'order', 'orders', 'café', 'cafe', '批准', '退款', 'iphone充电器'];
    const texts = [
      'Your refund was approved.',
      'Refunded orders ship today',
      'app approve order',
      'café au lait',
      '退款已经批准了',
      'iPhone充电器坏了',
      'the refunded order was approved by the app',
      'nothing here',
    ];
    const fields = texts.map((t) => searchableText({ output: t }));
    const word = fc.oneof(fc.constantFrom(...vocab), fc.constantFrom(...vocab).map((w) => w.slice(0, Math.max(1, w.length - 2))));
    const term = fc.tuple(fc.array(word, { minLength: 1, maxLength: 2 }), fc.boolean()).map(([ws, star]) => (ws.length > 1 ? `"${ws.join(' ')}"` : ws[0]) + (star ? '*' : ''));
    fc.assert(
      fc.property(fc.array(term, { minLength: 1, maxLength: 6 }), (parts) => {
        const q = parts.join(' ');
        const typed = { terms: splitTerms(q) };
        const normal = parseSearch(q);
        expect(normal.terms.length + new Set((normal.ignored ?? []).map((i) => i.term)).size).toBeLessThanOrEqual(typed.terms.length);
        for (const f of fields) expect(matchesTrace(f, normal).matched, `${q} on ${f.output}`).toBe(matchesTrace(f, typed).matched);
      }),
      { numRuns: 500 },
    );
  });

  it('is idempotent', () => {
    for (const q of ['w* w*', 'ref* refund refund', 'a b c a', '批 批 批*']) {
      const once = parseSearch(q);
      expect(normaliseTerms(once.terms).terms).toEqual(once.terms);
    }
  });
});

describe('refusing a query over the limits', () => {
  it(`refuses a prefix with fewer than ${SEARCH_MIN_PREFIX_CHARS} characters before the *, naming it`, () => {
    for (const q of ['w*', 'ab*', 'refund re*', '"agent sa"*', 'get_we*', 'é*', 'x1*']) {
      expect(searchRefusal(parseSearch(q)), q).toMatch(/: a prefix needs at least 3 letters or digits before the \*/);
    }
    expect(searchRefusal(parseSearch('w* x1*'))).toMatch(/^w\*, x1\*: /);
    for (const q of ['ref*', 'café*', '"agent sai"*', 'get_wea*', 'x12*', 'refund']) expect(searchRefusal(parseSearch(q)), q).toBeUndefined();
  });

  it('lets one Chinese, Japanese or Korean character be a prefix: it is a word of its own', () => {
    for (const q of ['批*', 'カ*', '환*', '々*', '"退款 批"*', 'iphone充*']) expect(searchRefusal(parseSearch(q)), q).toBeUndefined();
  });

  it(`refuses more than ${SEARCH_MAX_PREFIXES} prefix terms and more than ${SEARCH_MAX_TERMS} terms, counted after repeats are merged`, () => {
    expect(searchRefusal(parseSearch('aaa* bbb* ccc* ddd*'))).toBeUndefined();
    expect(searchRefusal(parseSearch('aaa* bbb* ccc* ddd* eee*'))).toMatch(/^5 prefix terms \(word\*\): a search takes at most 4/);
    expect(searchRefusal(parseSearch(Array(40).fill('aaa* bbb*').join(' ')))).toBeUndefined();
    const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
    expect(searchRefusal(parseSearch(words(16)))).toBeUndefined();
    expect(searchRefusal(parseSearch(words(17)))).toMatch(/^17 terms: a search takes at most 16/);
    // A phrase is one term, however many words it has.
    expect(searchRefusal(parseSearch(`"${words(60)}"`))).toBeUndefined();
  });
});

describe('pageOf', () => {
  it('cuts the same page a full sort would, near the top and far down', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 50 }), { maxLength: 400 }), fc.nat(420), fc.integer({ min: 1, max: 60 }), (values, offset, limit) => {
        // Ties broken by position, so the order is total, as searchOrder's is.
        const order = (i: number, j: number) => values[i] - values[j] || i - j;
        const sorted = values.map((_, i) => i).sort(order);
        expect(pageOf(values.length, order, offset, limit)).toEqual(sorted.slice(offset, offset + limit));
      }),
      { numRuns: 300 },
    );
  });
});

/*
 * The review's store: 200 words a trace from 3,000 that all start with w,
 * so `w*` starts every word in it. Its size is enough for each attack to
 * cost seconds before this change (the review measured 47 s for 32 `w*` at
 * 10,000 traces; at this size, before the change, 4 `w*` took 1.4 s of CPU
 * and 8 took 23.5 s on the machine in the changelog), and small enough to
 * build in a second.
 */
const REVIEW_TRACES = 2_000;
const reviewWords = Array.from({ length: 3000 }, (_, i) => `w${i.toString(36)}x`);
function reviewStore(): Trace[] {
  let seed = 7;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  return Array.from({ length: REVIEW_TRACES }, (_, i) => {
    const out = Array.from({ length: 200 }, () => reviewWords[Math.floor(rand() * reviewWords.length)]).join(' ');
    return { trace_id: `r-${String(i).padStart(5, '0')}`, agent_name: 'a', input: `q ${out.slice(0, 200)}`, output: out, timestamp: new Date(Date.UTC(2026, 8, 1) + i * 1000).toISOString() };
  });
}

/*
 * CPU milliseconds one refused or answered query may use on this store.
 * The worst query the limits allow measured 79 ms of CPU at 10,000 traces
 * (four of the broadest three-letter prefixes), so at 2,000 it has well over
 * ten times its cost in headroom for a slow CI runner; every attack below
 * cost seconds before the limits.
 */
const QUERY_CPU_MS = 1_000;

describe('adversarial queries, on the review’s store', () => {
  let dir: string;
  let store: SqliteAdapter;
  let scan: SqliteAdapter;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iris-search-budget-'));
    store = new SqliteAdapter(join(dir, 'iris.db'), { driver: SEARCH_DRIVER });
    await store.initialize();
    await store.insertTraces(LOCAL_TENANT, reviewStore());
    await store.whenSearchIndexReady();
    // The same file read without FTS5: the scan every search uses while the index is built.
    scan = new SqliteAdapter(join(dir, 'iris.db'), { driver: SEARCH_DRIVER, fts5: false });
    await scan.initialize();
    // Start each store's search thread before anything is timed: starting one is not a search's cost.
    for (const s of [store, scan]) await s.queryTraces(LOCAL_TENANT, { search: 'w0x', filter: { agent_name: 'nobody' } });
  }, 60_000);

  afterAll(async () => {
    await scan?.close();
    await store?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  /** Run one query on both paths; each must be refused, or answered, within the bound. */
  async function bounded(q: string): Promise<'refused' | 'answered'> {
    const refusal = searchRefusal(parseSearch(q));
    for (const s of [store, scan]) {
      let outcome: unknown;
      const cpu = await cpuMsAsync(async () => {
        outcome = await s.queryTraces(LOCAL_TENANT, { search: q, limit: 50 }).catch((err: Error) => err);
      });
      expect(cpu, `${JSON.stringify(q.slice(0, 60))} used ${cpu.toFixed(0)} ms of CPU`).toBeLessThan(QUERY_CPU_MS);
      if (refusal !== undefined) expect((outcome as Error).message, q).toBe(`Invalid search: ${refusal}`);
      else expect((outcome as { search: { complete: boolean } }).search, q).toBeDefined();
    }
    return refusal === undefined ? 'answered' : 'refused';
  }

  it('the review’s queries are refused before anything is read', async () => {
    for (const q of ['w*', 'w* w*', 'w* w* w* w*', Array(8).fill('w*').join(' '), Array(32).fill('w*').join(' '), 'w* '.repeat(166).slice(0, SEARCH_MAX_LENGTH), 'w1* w2* w3* w4*']) {
      expect(await bounded(q), q).toBe('refused');
    }
  });

  it('the costliest queries the limits allow answer within the bound', async () => {
    const broad3 = ['w10*', 'w11*', 'w12*', 'w13*'];
    const common = reviewWords.slice(0, 16);
    for (const q of [
      broad3.join(' '),
      `${'w1a* '.repeat(100)}`.trim(),
      common.join(' '),
      `"${common.join(' ')}"`,
      `"${'w0x '.repeat(124)}w0x"`,
      `"${reviewWords.slice(0, 60).join(' ')} w1a"*`,
      `${broad3.join(' ')} ${common.slice(0, 12).join(' ')}`,
    ]) {
      expect(await bounded(q), q).toBe('answered');
    }
  }, 60_000);

  it('any generated query is refused or answered within the bound', async () => {
    // Prefixes of every length over the store's own words, whole words, phrases of them, and repeats.
    const prefix = fc.constantFrom(...reviewWords.slice(0, 400)).chain((w) => fc.integer({ min: 1, max: w.length }).map((n) => `${w.slice(0, n)}*`));
    const phrase = fc.array(fc.constantFrom(...reviewWords.slice(0, 50)), { minLength: 2, maxLength: 8 }).map((ws) => `"${ws.join(' ')}"`);
    const part = fc.oneof(prefix, fc.constantFrom(...reviewWords.slice(0, 50)), phrase, fc.constantFrom('w*', 'w1*', 'w10*'));
    const query = fc.array(part, { minLength: 1, maxLength: 40 }).map((ps) => ps.join(' ').slice(0, SEARCH_MAX_LENGTH));
    let answered = 0;
    await fc.assert(
      fc.asyncProperty(query, async (q) => {
        if ((await bounded(q)) === 'answered') answered += 1;
      }),
      { numRuns: 60 },
    );
    // The set exercises both outcomes, not only refusals.
    expect(answered).toBeGreaterThan(5);
  }, 120_000);
});

describe('the time budget', () => {
  const corpus: Trace[] = Array.from({ length: 300 }, (_, i) => ({
    trace_id: `b-${String(i).padStart(4, '0')}`,
    agent_name: i % 2 ? 'odd' : 'even',
    output: `order ${i} was ${i % 3 ? 'shipped' : 'refunded'}${' order'.repeat(i % 5)}`,
    timestamp: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(),
    latency_ms: (i * 37) % 100,
  }));
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'iris-search-budget-time-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

  it(`defaults to ${SEARCH_BUDGET_MS} ms, and a search inside it is complete`, async () => {
    const s = new SqliteAdapter(':memory:', { driver: SEARCH_DRIVER });
    await s.initialize();
    await s.insertTraces(LOCAL_TENANT, corpus);
    const r = await s.queryTraces(LOCAL_TENANT, { search: 'order', limit: 1000 });
    expect(r.search).toEqual({ terms: ['order'], index: 'fts5', complete: true });
    expect(r.total).toBe(300);
    await s.close();
  });

  for (const fts5 of [true, false]) {
    const how = fts5 ? 'with the index' : 'without FTS5';
    it(`stops at the budget and answers with the best of the newest matches it read, ${how}`, async () => {
      // Budget 0: the index path stops at its first clock check (64 rows), the scan after its first batch (100 traces).
      const full = new SqliteAdapter(join(dir, `full-${fts5}.db`), { driver: SEARCH_DRIVER, fts5 });
      await full.initialize();
      await full.insertTraces(LOCAL_TENANT, corpus);
      await full.whenSearchIndexReady();
      await full.close();
      const cut = new SqliteAdapter(join(dir, `full-${fts5}.db`), { driver: SEARCH_DRIVER, fts5, searchBudgetMs: 0 });
      await cut.initialize();
      const whole = new SqliteAdapter(join(dir, `full-${fts5}.db`), { driver: SEARCH_DRIVER, fts5 });
      await whole.initialize();

      for (const [sort_by, sort_order] of [['relevance', 'desc'], ['timestamp', 'asc'], ['latency_ms', 'desc']] as const) {
        const r = await cut.queryTraces(LOCAL_TENANT, { search: 'order', limit: 1000, sort_by, sort_order });
        expect(r.search).toEqual({ terms: ['order'], index: fts5 ? 'fts5' : 'scan', complete: false, budget_ms: 0 });
        const read = fts5 ? 64 : 100;
        expect(r.total, sort_by).toBe(read);
        // The newest `read` traces, no others, ranked as the complete search ranks them.
        const newest = new Set(corpus.slice(-read).map((t) => t.trace_id));
        expect(r.traces.every((t) => newest.has(t.trace_id))).toBe(true);
        const ranked = (await whole.queryTraces(LOCAL_TENANT, { search: 'order', limit: 1000, sort_by, sort_order })).traces.map((t) => t.trace_id).filter((id) => newest.has(id));
        expect(r.traces.map((t) => t.trace_id)).toEqual(ranked);
        for (const t of r.traces) expect(t.match?.fragments.some((f) => f.hit)).toBe(true);
        // Pages are cut from that one ranking.
        const second = await cut.queryTraces(LOCAL_TENANT, { search: 'order', limit: 10, offset: 10, sort_by, sort_order });
        expect(second.traces.map((t) => t.trace_id)).toEqual(ranked.slice(10, 20));
      }
      // Less to read than one step still completes: fewer matches than a clock check apart, or fewer traces than a batch.
      const few = fts5
        ? await cut.queryTraces(LOCAL_TENANT, { search: 'refunded 30' })
        : await cut.queryTraces(LOCAL_TENANT, { search: 'order', filter: { since: corpus[250].timestamp } });
      expect(few.search?.complete).toBe(true);
      expect(few.total).toBe(fts5 ? 1 : 50);
      await cut.close();
      await whole.close();
    });
  }

  it('holds the scan, the slowest path, to its budget: it stops at the first batch that ends past the deadline', async () => {
    const path = join(dir, 'scan.db');
    const s = new SqliteAdapter(path, { driver: SEARCH_DRIVER, fts5: false });
    await s.initialize();
    await s.insertTraces(LOCAL_TENANT, reviewStore());
    await s.close();
    const read = async (searchBudgetMs: number) => {
      const store = new SqliteAdapter(path, { driver: SEARCH_DRIVER, fts5: false, searchBudgetMs, searchWorker: false });
      await store.initialize();
      /*
       * A clock the test drives, so the proof does not depend on how fast
       * this machine reads: every look at it moves it on 20 ms. The search
       * looks once to set its deadline and once after each batch of 100
       * traces, so with a 50 ms budget the batches end at 20, 40 and 60 ms
       * and the third is the first past the deadline.
       */
      let now = 0;
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => (now += 20) - 20);
      try {
        // `q` starts every input, so every trace read matches and `total` counts the traces read.
        return await store.queryTraces(LOCAL_TENANT, { search: 'q', limit: 50 });
      } finally {
        clock.mockRestore();
        await store.close();
      }
    };
    const all = await read(60_000);
    expect(all.search?.complete).toBe(true);
    expect(all.total).toBe(REVIEW_TRACES);
    const cut = await read(50);
    expect(cut.search).toMatchObject({ complete: false, budget_ms: 50 });
    expect(cut.total).toBe(300);
    expect(cut.traces).toHaveLength(50);
  });
});
