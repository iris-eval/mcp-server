/*
 * Which traces a search matches, and the page of them to show (#7, #703).
 *
 * This is the part of a search whose cost grows with the store: reading
 * the index (or, without FTS5, every trace), scoring and ranking; and the
 * page's snippets, which cost what the page's text does. It is written
 * against a bare Driver and plain data in and out, so the same code runs
 * on the search worker's own connection (search-worker.ts) and, for a
 * store with no file to share (`:memory:`), on the adapter's. The adapter
 * then reads only the page's rows.
 */
import type { Driver } from './driver.js';
import { cjkIndexed, readSpanText, BM25_WEIGHTS, CJK_BM25_WEIGHTS, CJK_TABLE, SEARCH_DOCS_TABLE, SEARCH_TABLE } from './search-index.js';
import { buildMatch, hasCjk, matchesTrace, searchableText, spansMayMatch, toCjkFtsQuery, toFtsQuery, type ParsedSearch, type TraceMatch } from './search.js';

/** What queryTraces hands its search half: the filters as SQL, and the page wanted. */
export interface SearchPlan {
  whereClause: string;
  params: unknown[];
  /** Whether any filter other than the tenant applies. */
  filtered: boolean;
  sortBy: string;
  sortOrder: string;
  limit: number;
  offset: number;
}

/** One search, as plain data: what the worker is sent. */
export interface MatchRequest {
  tenantId: string;
  parsed: ParsedSearch;
  plan: SearchPlan;
  /** `fts5` when the index holds every trace; `scan` reads the traces. */
  index: 'fts5' | 'scan';
  /** Milliseconds this search may read for, from when it starts (SEARCH_BUDGET_MS). */
  budgetMs: number;
}

/** The page chosen, in order, with each trace's snippet; how many matched, and whether the read reached the end. */
export interface MatchResult {
  total: number;
  pageIds: string[];
  /** Where each trace on the page matched, in pageIds' order; null where no field holds a term. */
  matches: Array<TraceMatch | null>;
  complete: boolean;
}

/** The SQL function readHits reads an index search's matches through. */
const SEARCH_HIT_FN = 'iris_search_hit';

type Sink = (doc: unknown, relevance: unknown, key: unknown) => number;
/** Where each connection's SEARCH_HIT_FN puts its rows while readHits runs. */
const sinks = new WeakMap<Driver, { current: Sink | undefined }>();

/** Define SEARCH_HIT_FN on this connection; once, before its first search. */
export function installSearchFunctions(db: Driver): void {
  const holder: { current: Sink | undefined } = { current: undefined };
  sinks.set(db, holder);
  db.fn(SEARCH_HIT_FN, (doc, relevance, key) => {
    if (!holder.current) throw new Error(`${SEARCH_HIT_FN} is only for the search's own statements`);
    return holder.current(doc, relevance, key);
  });
}

/** The matches an index search read, by column: each one's doc id, bm25 score, and the sort column's value when the sort is by one. */
interface SearchHits {
  doc: number[];
  relevance: number[];
  key: Array<number | string | null>;
}

/** SQLite's order for the values a sort column holds: NULL before any value. */
function sqliteCompare(a: number | string | null, b: number | string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

/**
 * The order a search's page is cut from, over the matches' positions in
 * `hits`, as the SQL that used to cut it ordered them. bm25 is lower for a
 * better match, so `desc` by relevance (the default) is best first; by a
 * column, the better match first among equal values; the newest indexed
 * wins any tie left, so every page is cut from one fixed ranking.
 */
function searchOrder(q: SearchPlan, hits: SearchHits): (i: number, j: number) => number {
  const { doc, relevance, key } = hits;
  if (q.sortBy === 'relevance') {
    const dir = q.sortOrder === 'desc' ? 1 : -1;
    return (i, j) => dir * (relevance[i] - relevance[j]) || doc[j] - doc[i];
  }
  const dir = q.sortOrder === 'desc' ? -1 : 1;
  return (i, j) => dir * sqliteCompare(key[i], key[j]) || relevance[i] - relevance[j] || doc[j] - doc[i];
}

/**
 * Positions `offset` to `offset + limit` of 0..n-1 in `order`, without
 * sorting all n when the page is near the top: the best offset + limit are
 * kept in a heap, O(n log k) (a page of 50 from 100,000 matches is the
 * common case). `order` must be total, as searchOrder's is.
 */
export function pageOf(n: number, order: (i: number, j: number) => number, offset: number, limit: number): number[] {
  const k = Math.min(n, offset + limit);
  if (k <= offset) return [];
  if (k * 4 > n) {
    const all = Array.from({ length: n }, (_, i) => i).sort(order);
    return all.slice(offset, k);
  }
  // A max-heap of the best k seen so far: the worst of them at the top, replaced by anything better.
  const heap: number[] = [];
  const worse = (a: number, b: number) => order(heap[a], heap[b]) > 0;
  const swap = (a: number, b: number) => {
    const t = heap[a];
    heap[a] = heap[b];
    heap[b] = t;
  };
  const down = (at: number) => {
    for (;;) {
      const l = 2 * at + 1;
      const r = l + 1;
      let top = at;
      if (l < heap.length && worse(l, top)) top = l;
      if (r < heap.length && worse(r, top)) top = r;
      if (top === at) return;
      swap(at, top);
      at = top;
    }
  };
  for (let i = 0; i < n; i += 1) {
    if (heap.length < k) {
      heap.push(i);
      for (let at = heap.length - 1; at > 0; ) {
        const parent = (at - 1) >> 1;
        if (!worse(at, parent)) break;
        swap(at, parent);
        at = parent;
      }
    } else if (order(i, heap[0]) < 0) {
      heap[0] = i;
      down(0);
    }
  }
  return heap.sort(order).slice(offset, k);
}

/**
 * Match one search on this connection (installSearchFunctions must have
 * run on it): the FTS5 index when `index` is `fts5`, else a read of the
 * traces, either way stopping at the budget.
 */
export function matchSearch(db: Driver, req: MatchRequest): MatchResult {
  // Read from here: the time budget covers every row either path reads.
  const deadline = performance.now() + req.budgetMs;
  if (req.parsed.terms.length === 0) return { total: 0, pageIds: [], matches: [], complete: true };
  const page = req.index === 'fts5' ? matchIndex(db, req, deadline) : scanForSearch(db, req.parsed, req.plan, deadline);
  return { ...page, matches: snippets(db, req.tenantId, req.parsed, page.pageIds) };
}

/**
 * The snippet of each trace on the page (buildMatch): from its own fields,
 * and from its span text only where those fields do not hold every term.
 * Built here, beside the search, because tokenizing a page of long traces
 * is itself tens of milliseconds, and here is off the server's thread.
 */
function snippets(db: Driver, tenantId: string, parsed: ParsedSearch, pageIds: string[]): Array<TraceMatch | null> {
  if (pageIds.length === 0) return [];
  const rows = db
    .prepare(`SELECT trace_id, input, output, tool_calls, metadata FROM traces WHERE tenant_id = ? AND trace_id IN (${pageIds.map(() => '?').join(', ')})`)
    .all(tenantId, ...pageIds) as Array<{ trace_id: string; input: string | null; output: string | null; tool_calls: string | null; metadata: string | null }>;
  // Parsed as the adapter reads a trace's row (rowToTrace), so the text is the text the caller is shown.
  const fields = new Map(
    rows.map((r) => [r.trace_id, { input: r.input ?? undefined, output: r.output ?? undefined, tool_calls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined, metadata: r.metadata ? JSON.parse(r.metadata) : undefined }]),
  );
  // Span text is read only for the traces whose own fields do not hold every term: the snippet comes from those fields otherwise.
  const needSpans = [...fields].filter(([, t]) => !matchesTrace(searchableText(t), parsed).matched).map(([id]) => id);
  const spanText = readSpanText(db, needSpans);
  return pageIds.map((id) => {
    const trace = fields.get(id);
    if (!trace) return null;
    const spans = spanText.get(id);
    return buildMatch(searchableText(trace, spans?.text), parsed, undefined, spans?.parts) ?? null;
  });
}

function matchIndex(db: Driver, req: MatchRequest, deadline: number): Omit<MatchResult, 'matches'> {
  const { parsed, plan: q, tenantId } = req;
  const match = toFtsQuery(parsed);
  /*
   * The traces table is joined only when a filter or the sort needs a
   * column of it; a plain ranked search is answered from the index and
   * the id table alone. When it is joined, idx_traces_search_filter
   * covers every column the filters read, so the join never reads a
   * trace row (search-index.ts has the measurement).
   *
   * The matches are read newest first, straight off the index (FTS5
   * walks its rowids in either order, and the doc id is the order traces
   * were indexed in), and ranked and paged here rather than by SQL, so
   * the read can stop at the time budget: SQL sorting would read every
   * match before the first row came back, and nothing can interrupt a
   * statement while it runs (readHits says how it stops one). Stopped
   * early, the page is the best of the newest matches read, and the
   * total counts those. What the index does before the first row comes
   * back, expanding a prefix term and bm25's count of the traces each
   * term is in, cannot be stopped: the query limits in search.ts bound it,
   * and the search worker keeps it off the server's event loop.
   */
  const joinTraces = q.filtered || q.sortBy !== 'relevance';
  let matched: string;
  let matchedParams: unknown[];
  if (!parsed.terms.some((t) => t.tokens.some(hasCjk)) && !cjkIndexed(db)) {
    // The doc id as the index's own rowid, so the newest-first order below is the index's and needs no sort.
    matched =
      `SELECT d.trace_id AS matched_id, ${SEARCH_TABLE}.rowid AS doc, bm25(${SEARCH_TABLE}, ${BM25_WEIGHTS}) AS relevance ` +
      `FROM ${SEARCH_TABLE} JOIN ${SEARCH_DOCS_TABLE} d ON d.doc_id = ${SEARCH_TABLE}.rowid ` +
      `WHERE ${SEARCH_TABLE} MATCH ? AND d.tenant_id = ?`;
    matchedParams = [match, tenantId];
  } else {
    /*
     * The query holds CJK, or some trace has a CJK stream (search-index.ts):
     * each term must match in the index or in the CJK stream, and the
     * relevance is the two bm25 scores added. A store and a query
     * without CJK never take this path.
     */
    const perTerm = parsed.terms.map((t) => ({ main: toFtsQuery({ terms: [t] }), cjk: toCjkFtsQuery(t) }));
    const inMain = `SELECT rowid FROM ${SEARCH_TABLE} WHERE ${SEARCH_TABLE} MATCH ?`;
    const inCjk = `SELECT rowid FROM ${CJK_TABLE} WHERE ${CJK_TABLE} MATCH ?`;
    // Every trace either table matches for any term, with its two scores added; then each term must match in one of them.
    const scored =
      `SELECT doc, SUM(r) AS relevance FROM (` +
      `SELECT rowid AS doc, bm25(${SEARCH_TABLE}, ${BM25_WEIGHTS}) AS r FROM ${SEARCH_TABLE} WHERE ${SEARCH_TABLE} MATCH ? ` +
      `UNION ALL SELECT rowid AS doc, bm25(${CJK_TABLE}, ${CJK_BM25_WEIGHTS}) AS r FROM ${CJK_TABLE} WHERE ${CJK_TABLE} MATCH ?) GROUP BY doc`;
    const everyTerm = perTerm.length > 1 ? ` AND ${perTerm.map(() => `(d.doc_id IN (${inMain}) OR d.doc_id IN (${inCjk}))`).join(' AND ')}` : '';
    /*
     * The GROUP BY reads and scores every match before the first row, so
     * the budget cannot stop this path early; the query limits bound it
     * (search.ts). LIMIT -1 keeps SQLite planning it on its own, driven
     * by the per-term lists: merged into the newest-first read below, it
     * picked a plan 2.6 times slower (75 ms against 28 for 16 CJK
     * characters at 10,000 traces).
     */
    matched = `SELECT d.trace_id AS matched_id, d.doc_id AS doc, x.relevance AS relevance FROM (${scored}) x JOIN ${SEARCH_DOCS_TABLE} d ON d.doc_id = x.doc WHERE d.tenant_id = ?${everyTerm} LIMIT -1`;
    matchedParams = [perTerm.map((p) => p.main).join(' OR '), perTerm.map((p) => `(${p.cjk})`).join(' OR '), tenantId, ...(perTerm.length > 1 ? perTerm.flatMap((p) => [p.main, p.cjk]) : [])];
  }
  // CROSS JOIN keeps the matches the outer loop, so they arrive in the index's order and no filter makes SQLite sort them first.
  const from = joinTraces ? `FROM (${matched}) m CROSS JOIN traces ON traces.trace_id = m.matched_id ${q.whereClause}` : `FROM (${matched}) m`;
  const params = joinTraces ? [...matchedParams, ...q.params] : matchedParams;
  // Numbers only (and the sort column's value): the page's trace ids are looked up once it is chosen.
  const key = q.sortBy === 'relevance' ? 'NULL' : `traces.${q.sortBy}`;
  const hits = readHits(db, `SELECT m.doc AS doc, m.relevance AS relevance, ${key} AS k ${from} ORDER BY m.doc DESC`, params, deadline);
  const pageDocs = pageOf(hits.doc.length, searchOrder(q, hits), q.offset, q.limit).map((i) => hits.doc[i]);
  const idOf = new Map<number, string>();
  if (pageDocs.length > 0) {
    const idRows = db.prepare(`SELECT doc_id, trace_id FROM ${SEARCH_DOCS_TABLE} WHERE doc_id IN (${pageDocs.map(() => '?').join(', ')})`).all(...pageDocs) as Array<{ doc_id: number; trace_id: string }>;
    for (const r of idRows) idOf.set(Number(r.doc_id), r.trace_id);
  }
  return { total: hits.doc.length, pageIds: pageDocs.flatMap((doc) => idOf.get(doc) ?? []), complete: hits.complete };
}

/**
 * Read an index search's matches, newest first, until they run out or
 * the deadline passes. The rows go through a SQL function (SEARCH_HIT_FN)
 * that keeps each one, rather than back to JavaScript one step at a time:
 * that is as fast as SQL sorting them (about 310 ms against 325 for
 * 100,000 matches, measured on the machine in the changelog; a row
 * iterator took 400 to 430), and a statement can be stopped from inside
 * it, which nothing else can do while it runs. Every 64 rows it checks the
 * clock, and past the deadline it throws, which ends the statement; what
 * it kept so far is the answer, marked incomplete.
 */
function readHits(db: Driver, select: string, params: unknown[], deadline: number): SearchHits & { complete: boolean } {
  const holder = sinks.get(db);
  if (!holder) throw new Error('installSearchFunctions has not run on this connection');
  const hits: SearchHits = { doc: [], relevance: [], key: [] };
  let stopped = false;
  holder.current = (doc, relevance, key) => {
    hits.doc.push(doc as number);
    hits.relevance.push(relevance as number);
    hits.key.push(key as number | string | null);
    if ((hits.doc.length & 63) === 0 && performance.now() > deadline) {
      stopped = true;
      throw new Error('search time budget reached');
    }
    return 1;
  };
  try {
    // LIMIT -1 keeps the query a subquery SQLite reads row by row, rather than one it merges into the count (where bm25 cannot run).
    db.prepare(`SELECT count(${SEARCH_HIT_FN}(doc, relevance, k)) FROM (${select} LIMIT -1)`).get(...params);
  } catch (err) {
    if (!stopped) throw err;
  } finally {
    holder.current = undefined;
  }
  return { ...hits, complete: !stopped };
}

/**
 * Search without FTS5: read the traces the filters admit, newest first
 * (by rowid, the order they were stored in), in batches so memory stays
 * flat, and test each with the tokenizer the index would have used.
 * Relevance is how many times the terms occur (in the trace's own fields,
 * or with its spans when those alone do not match). The read stops after
 * the first batch that ends past `deadline`, and `complete` says whether
 * it reached the oldest trace; a batch is small enough that the stop comes
 * within tens of milliseconds of the deadline, spans included.
 */
function scanForSearch(db: Driver, parsed: ParsedSearch, q: SearchPlan, deadline: number): Omit<MatchResult, 'matches'> {
  const BATCH = 100;
  /*
   * NOT INDEXED walks the table itself by rowid, where each batch is a
   * seek. Left to choose, SQLite read the tenant's rows through a
   * (tenant_id, …) index and sorted them all by rowid for every batch:
   * 336 ms a batch at 100,000 traces, where the walk takes 0.4 ms. The
   * filters still apply, row by row as the walk reads them.
   */
  const read = db.prepare(
    `SELECT rowid AS rid, trace_id, input, output, tool_calls, metadata, timestamp, latency_ms, cost_usd FROM traces NOT INDEXED ${q.whereClause} AND rowid < ? ORDER BY rowid DESC LIMIT ${BATCH}`,
  );
  const parse = (v: unknown): unknown => {
    if (typeof v !== 'string') return undefined;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  };
  const found: Array<{ id: string; hits: number; timestamp: string; key: number | string | null }> = [];
  let before = Number.MAX_SAFE_INTEGER;
  let complete = true;
  for (;;) {
    const rows = read.all(...q.params, before) as Array<Record<string, unknown>>;
    /*
     * A trace's own fields first; its span text (a JSON walk in SQL, the
     * costly part) only for the traces those fields do not match and whose
     * stored span JSON could hold the missing words (spansMayMatch). A
     * trace matched by its own fields is ranked by the hits in them.
     */
    const own = rows.map((row) => {
      const fields = searchableText({ input: row.input, output: row.output, tool_calls: parse(row.tool_calls), metadata: parse(row.metadata) });
      return { row, fields, result: matchesTrace(fields, parsed) };
    });
    const unmatched = own.filter((o) => !o.result.matched);
    const raw = new Map<string, string>();
    if (unmatched.length > 0) {
      const ids = unmatched.map((o) => o.row.trace_id as string);
      const rawRows = db
        .prepare(`SELECT trace_id, group_concat(COALESCE(attributes, '') || char(10) || COALESCE(events, ''), char(10)) AS raw FROM spans WHERE trace_id IN (${ids.map(() => '?').join(', ')}) GROUP BY trace_id`)
        .all(...ids) as Array<{ trace_id: string; raw: string }>;
      for (const r of rawRows) raw.set(r.trace_id, r.raw);
    }
    const spanText = readSpanText(
      db,
      unmatched.filter((o) => raw.has(o.row.trace_id as string) && spansMayMatch(o.fields, parsed, raw.get(o.row.trace_id as string)!)).map((o) => o.row.trace_id as string),
    );
    for (const { row, fields, result } of own) {
      const spans = spanText.get(row.trace_id as string);
      const { matched, hits } = result.matched || !spans ? result : matchesTrace({ ...fields, spans: spans.text }, parsed);
      if (!matched) continue;
      found.push({
        id: row.trace_id as string,
        hits,
        timestamp: row.timestamp as string,
        key: q.sortBy === 'relevance' ? null : ((row[q.sortBy] as number | string | null | undefined) ?? null),
      });
    }
    if (rows.length < BATCH) break;
    before = Number(rows[rows.length - 1].rid);
    if (performance.now() > deadline) {
      complete = false;
      break;
    }
  }
  // SQLite's order, so the fallback pages exactly as the indexed path would: NULL before any value.
  const cmp = sqliteCompare;
  const dir = q.sortOrder === 'desc' ? -1 : 1;
  found.sort((a, b) =>
    q.sortBy === 'relevance'
      ? dir * (a.hits - b.hits) || cmp(b.timestamp, a.timestamp) || cmp(a.id, b.id)
      : dir * cmp(a.key, b.key) || b.hits - a.hits || cmp(a.id, b.id),
  );
  return { total: found.length, pageIds: found.slice(q.offset, q.offset + q.limit).map((f) => f.id), complete };
}
