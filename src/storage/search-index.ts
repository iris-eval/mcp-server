/*
 * The full-text index over traces (#7): its schema, how it stays in sync,
 * and what happens on a SQLite without FTS5.
 *
 * Shape.
 *
 *   trace_search_docs  doc_id INTEGER PRIMARY KEY → (tenant_id, trace_id).
 *                      The index needs an integer row id per trace, and
 *                      traces.rowid is not one it can keep: traces has a
 *                      TEXT primary key, so its rowid is implicit and VACUUM
 *                      may renumber it — and `--purge` runs VACUUM. An
 *                      INTEGER PRIMARY KEY is never renumbered. A trace has a
 *                      row here exactly when its words are in the index.
 *   trace_search       FTS5, contentless (content=''): it holds the
 *                      inverted index and no copy of the text. iris.db holds
 *                      agent inputs and outputs verbatim once already; a
 *                      second copy would be a second place the text of a
 *                      deleted trace could survive, and would double the
 *                      file. The snippet is built from the trace row the
 *                      query returns anyway (search.ts).
 *   idx_traces_search_filter
 *                      a covering index for the join back to traces; see
 *                      SEARCH_FILTER_INDEX below.
 *
 * What is indexed. input and output as they are; tool_calls and metadata
 * by their string and number leaves, extracted by SQLite's json_tree, never
 * their keys — searching "output" must not match every trace that has a
 * tool call; and the text of the trace's spans (#683, below). The
 * extraction is one SQL expression (indexRow below) used by every write,
 * so the values a delete hands FTS5 are the values the insert gave it.
 *
 * Span text. A trace sent over OTLP keeps its first model call's input and
 * output on the trace row; the later model calls of an agent loop, tool
 * arguments and results, and exception messages are only in its spans. The
 * fifth column is the string values of each span's attributes and of its
 * events' attributes:
 *   - never keys, numbers or booleans (token counts and latencies are
 *     noise to a search), and not the span ids the OTLP door keeps
 *     (otel.span_id, otel.parent_span_id: random hex). Resource attributes
 *     are not stored on spans, so the service name that repeats on every
 *     trace is not in it;
 *   - a string that holds a JSON object or array (`gen_ai.input.messages`
 *     is one) by its string leaves, so the keys inside it are not words of
 *     every trace;
 *   - each distinct string once per trace. A model call re-sends the whole
 *     conversation so far, so an agent loop's later calls repeat every
 *     earlier message; indexed once, the history costs nothing more;
 *   - in span start order (then span id, then attribute order), so the
 *     text is the same however the spans were written;
 *   - each value cut to SPAN_VALUE_MAX_CHARS, and the trace's span text to
 *     SPAN_TEXT_MAX_CHARS, so one large payload cannot dominate the index.
 * It is computed in SQL (spanValuesSql below) from the spans table, like the
 * other columns from the trace row, so every write and every trigger
 * derives it the same way and no copy of it is stored. A trace's words are
 * taken out of the index BEFORE its row is deleted, because the cascade
 * removes its spans with it, and the triggers on spans re-index a trace
 * whose spans change after it was indexed (insertSpan, or a hand-run
 * statement), so a delete always hands FTS5 the text it was given.
 *
 * Staying in sync: inserts are written by the adapter, updates and deletes
 * by triggers.
 *   - Deletes and updates are triggers because a trace leaves the table by
 *     several routes — delete_trace, the retention sweep, --purge, a
 *     hand-run DELETE by an operator — and changes by one (the metadata
 *     patch). A trigger runs on every route, in the same transaction,
 *     including routes written after this file. The same holds for spans:
 *     a span inserted, updated or deleted on a trace already in the index
 *     re-indexes that trace.
 *   - Inserts are not, because they cannot be fast from a trigger: SQLite
 *     runs each trigger statement inside a statement savepoint, and FTS5
 *     flushes its pending terms to a new segment at every savepoint. A batch
 *     of 1,000 traces became 1,000 one-document segments and a merge storm:
 *     255 µs per trace from a trigger against 76 µs from the same statement
 *     run by the adapter (measured on the machine in the changelog). There
 *     is one insert route (insertTraces), and it writes the index in the
 *     transaction that writes the trace, after the batch's traces and
 *     spans, in one statement: a span trigger's savepoint then never
 *     follows FTS5 terms still pending in the batch. A trace inserted any
 *     other way has no docs row, so the delete trigger leaves the index
 *     alone for it, and the next start indexes it (reconcileSearchIndex,
 *     then the build).
 *
 * Building. The migration creates the index empty. The traces already
 * stored are indexed after the start, BUILD_BATCH at a time, each step its
 * own short transaction with the event loop free between steps, so the
 * server answers MCP and HTTP requests throughout; searches read the traces
 * (the scan) until the index holds every one, then use it. A new trace is
 * indexed on insert even mid-build, and the build skips it. Closing stops the
 * build at its next step and the next start carries on from there.
 *
 * Erasure. `secure-delete` is set on the index (SQLite 3.42+): deleting a
 * row removes its words from the index at once instead of leaving them in
 * older segments until a merge, so a deleted trace's words are gone from
 * the file the way its row is (the database already runs with
 * secure_delete = ON; see sqlite-adapter.ts). That is why a delete is FTS5's
 * 'delete' command with the row's old values and not contentless_delete=1:
 * that option deletes by rowid through a tombstone and leaves the words in
 * the segment, where `strings iris.db` finds them (the erasure test in
 * tests/unit/storage/trace-search.test.ts caught exactly that).
 * secure-delete costs about 2.6 ms a row, which a sweep of thousands cannot
 * pay; bulkIndexDelete below erases a large delete by rewriting the index
 * once instead, with the same result on disk.
 *
 * Without FTS5. better-sqlite3's bundled SQLite has FTS5. Node's built-in
 * node:sqlite has it from Node 22.16.0; on 22.13.0 to 22.15.0 it does not
 * (checked on each release), and a better-sqlite3 built from source against
 * a system SQLite may not either. The CI search-index job runs Linux, macOS
 * and Windows with both drivers, the built-in at 22.13.0 and 24. Without
 * FTS5 the migration creates nothing, the adapter answers a search
 * by reading the traces themselves with the same tokenizer (slower, the same
 * matches), and on the first start with FTS5 the index is built. A file whose
 * index exists but whose SQLite cannot load FTS5 has its triggers dropped at
 * start — otherwise every delete would fail on "no such module" — and the
 * index is rebuilt from scratch on the next start that can. An index built
 * before the span column (four columns) is dropped and rebuilt the same
 * way on the first start with FTS5.
 */
import type { Driver } from './driver.js';
import { cjkStream, hasCjk, searchableText, streamText, SEARCH_FIELDS } from './search.js';

export const SEARCH_TABLE = 'trace_search';
export const SEARCH_DOCS_TABLE = 'trace_search_docs';
const TRIGGERS = [
  'trace_search_au',
  'trace_search_bd',
  'trace_search_spans_bi',
  'trace_search_spans_ai',
  'trace_search_spans_bd',
  'trace_search_spans_ad',
  'trace_search_spans_bu',
  'trace_search_spans_au',
] as const;

/*
 * The CJK stream (#682; search.ts, cjkStream, says what it holds). It is
 * built in JavaScript, and a trigger cannot run JavaScript, so it is kept
 * the way the spans text is not: its own contentless FTS5 table, filled
 * only for traces that hold CJK text, and beside it the exact text each row
 * was given (CJK_DOCS_TABLE), which every delete hands back. A trace whose
 * text changes after it was indexed (the metadata patch, a span added or
 * edited, by the adapter or by hand) has its CJK row taken out at once, by
 * trigger and exactly, and is queued (CJK_PENDING_TABLE) to be streamed
 * again: by the adapter straight after its own writes, and by the build at
 * the next start for anything else. Traces with no CJK never enter any of
 * the three tables.
 */
export const CJK_TABLE = 'trace_search_cjk';
export const CJK_DOCS_TABLE = 'trace_search_cjk_docs';
export const CJK_PENDING_TABLE = 'trace_search_cjk_pending';
const CJK_COLUMNS = 'input, output, tool_calls, metadata, spans, uni';
/** bm25 weights of the CJK stream's columns, as the main index weighs its fields; `uni` like the rest of the side fields. */
export const CJK_BM25_WEIGHTS = '1.0, 1.0, 0.5, 0.5, 0.5, 0.5';
const RETIRED_CJK_TABLE = 'trace_search_cjk_retired';
const RETIRED_CJK_DOCS_TABLE = 'trace_search_cjk_docs_retired';
/** Triggers an earlier release created: dropped wherever the current ones are. */
const RETIRED_TRIGGERS = ['trace_search_ad'] as const;
const ALL_TRIGGERS = [...TRIGGERS, ...RETIRED_TRIGGERS];

/**
 * Every column a trace filter or sort reads, keyed by trace_id. A search
 * joins each matched id back to traces to apply the other filters; without
 * this index that join reads the trace row itself, and tenant_id and
 * timestamp sit after input, output and tool_calls in it — past kilobytes of
 * text, often on overflow pages. Measured at 100k traces on the machine in
 * the changelog: a word in 6% of traces took 350 ms through the row and
 * 23 ms through this index.
 */
export const SEARCH_FILTER_INDEX = 'idx_traces_search_filter';

/**
 * bm25 column weights, in column order: input, output, tool_calls, metadata,
 * spans. A word in what the agent was asked or said counts twice a word in
 * a tool argument, a metadata value or a span attribute, which carry ids
 * and boilerplate as well as text.
 */
export const BM25_WEIGHTS = '1.0, 1.0, 0.5, 0.5, 0.5';

/** String and number leaves of a JSON column; text that is not JSON is indexed as it is. */
function jsonText(col: string): string {
  return `CASE WHEN json_valid(${col}) THEN (SELECT group_concat(value, ' ') FROM json_tree(${col}) WHERE type IN ('text', 'integer', 'real')) ELSE ${col} END`;
}

/** Longest single span value indexed, in characters. */
export const SPAN_VALUE_MAX_CHARS = 4_096;
/** Most span text one trace indexes, in characters. */
export const SPAN_TEXT_MAX_CHARS = 32_768;
/** Between two span values, as between the leaves of the other JSON columns in a snippet. */
export const SPAN_TEXT_SEPARATOR = ' · ';

/** Attributes the OTLP door adds to every span to keep the sender's ids (src/otel/ingest.ts). */
const DOOR_SPAN_KEYS = "'otel.span_id', 'otel.parent_span_id'";

/** json_tree's input for one attribute value: an object or array as it is, text that holds one parsed, any other value quoted so its one leaf is itself. */
function leafSource(value: string, type: string): string {
  return `CASE WHEN ${type} IN ('object', 'array') THEN ${value} WHEN ${type} = 'text' AND substr(ltrim(${value}), 1, 1) IN ('{', '[') AND json_valid(${value}) THEN ${value} ELSE json_quote(${value}) END`;
}

/**
 * Every string leaf of the spans matching `where` (over s, the spans row):
 * attributes, then each event's attributes, with the order they sort by.
 */
function spanLeaves(where: string): string {
  return `SELECT s.trace_id, s.span_id, s.name, s.start_time, 0 AS src, a.id AS a_ord, t.id AS t_ord, t.value AS leaf
      FROM spans s, json_each(CASE WHEN json_valid(s.attributes) THEN s.attributes ELSE '{}' END) a, json_tree(${leafSource('a.value', 'a.type')}) t
      WHERE ${where} AND a.key NOT IN (${DOOR_SPAN_KEYS}) AND t.type = 'text'
    UNION ALL
    SELECT s.trace_id, s.span_id, s.name, s.start_time, 1 + e.key, ea.id, t.id, t.value
      FROM spans s, json_each(CASE WHEN json_valid(s.events) THEN s.events ELSE '[]' END) e,
        json_each(CASE WHEN e.type = 'object' AND json_type(e.value, '$.attributes') = 'object' THEN json_extract(e.value, '$.attributes') ELSE '{}' END) ea,
        json_tree(${leafSource('ea.value', 'ea.type')}) t
      WHERE ${where} AND t.type = 'text'`;
}

/** A span leaf's place in the text: start time, span id, then where in the span; compared as a string, it sorts as that tuple. */
const LEAF_ORDER = `printf('%s%s%s%s%08d%08d%08d', start_time, char(1), span_id, char(1), src, a_ord, t_ord)`;

/**
 * The distinct span values of the traces whose spans match `where`, one
 * row each (trace_id, span_id, name, v, k), each cut to
 * SPAN_VALUE_MAX_CHARS and placed by `k`, the first place it occurs. The
 * one definition of span text: the index column is these values joined by
 * SPAN_TEXT_SEPARATOR in `k` order and cut to SPAN_TEXT_MAX_CHARS
 * (spanTextSql), and the snippet and the search without FTS5 join the same
 * rows the same way (readSpanText).
 */
export function spanValuesSql(where: string): string {
  return `SELECT trace_id, span_id, name, v, MIN(k) AS k FROM (
      SELECT trace_id, span_id, name, substr(trim(leaf), 1, ${SPAN_VALUE_MAX_CHARS}) AS v, ${LEAF_ORDER} AS k FROM (${spanLeaves(where)})
    ) WHERE v <> '' GROUP BY trace_id, v`;
}

/** The span text of the trace `traceRef` names, as the index column holds it. */
export function spanTextSql(traceRef: string): string {
  return `(SELECT substr(COALESCE(group_concat(v, '${SPAN_TEXT_SEPARATOR}' ORDER BY k), ''), 1, ${SPAN_TEXT_MAX_CHARS}) FROM (${spanValuesSql(`s.trace_id = ${traceRef}`)}))`;
}

/**
 * The five indexed values of a trace, in column order: the one expression
 * every write uses. `ref` names a trace row (t, OLD, NEW); the span text is
 * read from the spans table by its trace id.
 */
function indexRow(ref: string): string {
  return `${ref}.input, ${ref}.output, ${jsonText(`${ref}.tool_calls`)}, ${jsonText(`${ref}.metadata`)}, ${spanTextSql(`${ref}.trace_id`)}`;
}

const COLUMNS = 'input, output, tool_calls, metadata, spans';

/** Index the traces whose docs rows match `where` (over d, the docs row, and t, the trace). */
const INDEX_WHERE = (where: string) =>
  `INSERT INTO ${SEARCH_TABLE} (rowid, ${COLUMNS}) SELECT d.doc_id, ${indexRow('t')} FROM ${SEARCH_DOCS_TABLE} d JOIN traces t ON t.trace_id = d.trace_id WHERE ${where}`;

/** The 'delete' command: FTS5 needs the values the row was indexed with, recomputed from OLD. Nothing when the trace was never indexed. */
const DELETE_OLD = `INSERT INTO ${SEARCH_TABLE} (${SEARCH_TABLE}, rowid, ${COLUMNS})
      SELECT 'delete', doc_id, ${indexRow('OLD')} FROM ${SEARCH_DOCS_TABLE} WHERE trace_id = OLD.trace_id`;

/** Take the indexed trace `traceRef` names out of the index, with the values it holds now. */
const UNINDEX = (traceRef: string) =>
  `INSERT INTO ${SEARCH_TABLE} (${SEARCH_TABLE}, rowid, ${COLUMNS}) SELECT 'delete', d.doc_id, ${indexRow('t')} FROM ${SEARCH_DOCS_TABLE} d JOIN traces t ON t.trace_id = d.trace_id WHERE d.trace_id = ${traceRef}`;
/** Put it back, with the values it holds now. */
const REINDEX = (traceRef: string) => INDEX_WHERE(`d.trace_id = ${traceRef}`);

/** The doc id of the trace `traceRef` names. */
const docOf = (traceRef: string) => `(SELECT doc_id FROM ${SEARCH_DOCS_TABLE} WHERE trace_id = ${traceRef})`;
/** Take the trace's CJK row out with the text it was given, and forget that text. */
const CJK_UNINDEX = (traceRef: string) =>
  `INSERT INTO ${CJK_TABLE} (${CJK_TABLE}, rowid, ${CJK_COLUMNS}) SELECT 'delete', doc_id, ${CJK_COLUMNS} FROM ${CJK_DOCS_TABLE} WHERE doc_id = ${docOf(traceRef)};
    DELETE FROM ${CJK_DOCS_TABLE} WHERE doc_id = ${docOf(traceRef)}`;
/**
 * Whether a stored value could hold CJK: any character past ASCII, or a \u
 * escape (a JSON string inside a span attribute, written by a client that
 * escapes, spells CJK that way). Cheap and never wrong the other way; the
 * stream itself decides.
 */
const mayHoldCjk = (e: string) => `(length(${e}) <> length(CAST(${e} AS BLOB)) OR instr(${e}, '\\u') > 0)`;
const traceMayHoldCjk = (traceRef: string) =>
  `(EXISTS (SELECT 1 FROM traces t WHERE t.trace_id = ${traceRef} AND (${mayHoldCjk('t.input')} OR ${mayHoldCjk('t.output')} OR ${mayHoldCjk('t.tool_calls')} OR ${mayHoldCjk('t.metadata')}))
    OR EXISTS (SELECT 1 FROM spans s WHERE s.trace_id = ${traceRef} AND (${mayHoldCjk('s.attributes')} OR ${mayHoldCjk('s.events')})))`;
/** Queue the trace to be streamed again when its text could hold CJK. */
const CJK_PEND = (traceRef: string) => `INSERT OR IGNORE INTO ${CJK_PENDING_TABLE} (doc_id) SELECT doc_id FROM ${SEARCH_DOCS_TABLE} WHERE trace_id = ${traceRef} AND ${traceMayHoldCjk(traceRef)}`;

const CREATE_CJK_TABLES = `
  CREATE TABLE IF NOT EXISTS ${CJK_DOCS_TABLE} (
    doc_id INTEGER PRIMARY KEY,
    input TEXT NOT NULL, output TEXT NOT NULL, tool_calls TEXT NOT NULL, metadata TEXT NOT NULL, spans TEXT NOT NULL, uni TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ${CJK_PENDING_TABLE} (doc_id INTEGER PRIMARY KEY);
  CREATE VIRTUAL TABLE IF NOT EXISTS ${CJK_TABLE} USING fts5(
    ${CJK_COLUMNS},
    content = '',
    tokenize = 'unicode61 remove_diacritics 2'
  );
`;

const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS ${SEARCH_DOCS_TABLE} (
    doc_id INTEGER PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    trace_id TEXT NOT NULL UNIQUE
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS ${SEARCH_TABLE} USING fts5(
    ${COLUMNS},
    content = '',
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE INDEX IF NOT EXISTS ${SEARCH_FILTER_INDEX} ON traces (trace_id, tenant_id, timestamp, agent_name, framework, session_id, latency_ms, cost_usd);
`;

/*
 * The delete trigger runs BEFORE the row goes: the foreign key's cascade
 * deletes the trace's spans with it, and an AFTER trigger would find none
 * left to recompute the span text from. The span triggers' WHEN clause is
 * a lookup in the docs table's unique index; during insertTraces the docs
 * rows are written after the spans, so it is false there and they cost
 * that lookup alone.
 */
const indexed = (traceRef: string) => `EXISTS (SELECT 1 FROM ${SEARCH_DOCS_TABLE} WHERE trace_id = ${traceRef})`;
const SPAN_COLUMNS = 'trace_id, span_id, name, start_time, attributes, events';
const CREATE_TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS trace_search_au AFTER UPDATE OF input, output, tool_calls, metadata, trace_id, tenant_id ON traces BEGIN
    ${DELETE_OLD};
    ${CJK_UNINDEX('OLD.trace_id')};
    UPDATE ${SEARCH_DOCS_TABLE} SET tenant_id = NEW.tenant_id, trace_id = NEW.trace_id WHERE trace_id = OLD.trace_id;
    INSERT INTO ${SEARCH_TABLE} (rowid, ${COLUMNS}) SELECT doc_id, ${indexRow('NEW')} FROM ${SEARCH_DOCS_TABLE} WHERE trace_id = NEW.trace_id;
    ${CJK_PEND('NEW.trace_id')};
  END;
  CREATE TRIGGER IF NOT EXISTS trace_search_bd BEFORE DELETE ON traces BEGIN
    ${DELETE_OLD};
    ${CJK_UNINDEX('OLD.trace_id')};
    DELETE FROM ${CJK_PENDING_TABLE} WHERE doc_id = ${docOf('OLD.trace_id')};
    DELETE FROM ${SEARCH_DOCS_TABLE} WHERE trace_id = OLD.trace_id;
  END;
  CREATE TRIGGER IF NOT EXISTS trace_search_spans_bi BEFORE INSERT ON spans WHEN ${indexed('NEW.trace_id')} BEGIN
    ${UNINDEX('NEW.trace_id')};
    ${CJK_UNINDEX('NEW.trace_id')};
  END;
  CREATE TRIGGER IF NOT EXISTS trace_search_spans_ai AFTER INSERT ON spans WHEN ${indexed('NEW.trace_id')} BEGIN
    ${REINDEX('NEW.trace_id')};
    ${CJK_PEND('NEW.trace_id')};
  END;
  CREATE TRIGGER IF NOT EXISTS trace_search_spans_bd BEFORE DELETE ON spans WHEN ${indexed('OLD.trace_id')} BEGIN
    ${UNINDEX('OLD.trace_id')};
    ${CJK_UNINDEX('OLD.trace_id')};
  END;
  CREATE TRIGGER IF NOT EXISTS trace_search_spans_ad AFTER DELETE ON spans WHEN ${indexed('OLD.trace_id')} BEGIN
    ${REINDEX('OLD.trace_id')};
    ${CJK_PEND('OLD.trace_id')};
  END;
  CREATE TRIGGER IF NOT EXISTS trace_search_spans_bu BEFORE UPDATE OF ${SPAN_COLUMNS} ON spans BEGIN
    ${UNINDEX('OLD.trace_id')};
    ${CJK_UNINDEX('OLD.trace_id')};
    ${UNINDEX('NEW.trace_id')} AND NEW.trace_id IS NOT OLD.trace_id;
    INSERT INTO ${CJK_TABLE} (${CJK_TABLE}, rowid, ${CJK_COLUMNS}) SELECT 'delete', doc_id, ${CJK_COLUMNS} FROM ${CJK_DOCS_TABLE} WHERE doc_id = ${docOf('NEW.trace_id')} AND NEW.trace_id IS NOT OLD.trace_id;
    DELETE FROM ${CJK_DOCS_TABLE} WHERE doc_id = ${docOf('NEW.trace_id')} AND NEW.trace_id IS NOT OLD.trace_id;
  END;
  CREATE TRIGGER IF NOT EXISTS trace_search_spans_au AFTER UPDATE OF ${SPAN_COLUMNS} ON spans BEGIN
    ${REINDEX('OLD.trace_id')};
    ${REINDEX('NEW.trace_id')} AND NEW.trace_id IS NOT OLD.trace_id;
    ${CJK_PEND('OLD.trace_id')};
    ${CJK_PEND('NEW.trace_id')};
  END;
`;

/**
 * The background build's step, in milliseconds of work: a request waits at
 * most about this long behind it. What a trace costs to index depends on
 * its text (a trace with an agent loop's spans takes several times one
 * without), so the adapter sizes each step from how long the last one took,
 * starting at BUILD_BATCH traces and kept within BUILD_BATCH_RANGE.
 */
export const BUILD_STEP_MS = 50;
export const BUILD_BATCH = 32;
export const BUILD_BATCH_RANGE = [8, 1024] as const;

/** The next step's size, from the last one's size and the milliseconds it took. */
export function nextBuildBatch(size: number, tookMs: number): number {
  const [min, max] = BUILD_BATCH_RANGE;
  const scaled = tookMs > 0 ? Math.round((size * BUILD_STEP_MS) / tookMs) : max;
  // At most double per step, so one fast step on small traces cannot size the next to many large ones.
  return Math.max(min, Math.min(max, size * 2, scaled));
}

/**
 * One step of the build: the next `max` traces after `after` (a traces
 * rowid), each indexed unless it already is (ids first, then its words),
 * under one write lock. Walking by rowid keeps every step the same small
 * cost; a step that searched the whole table for unindexed traces made the
 * build quadratic (178 s at 100,000 traces, one step stalling 2.5 s).
 * Returns the last rowid it covered, or null past the end of the table.
 */
export function indexNextBatch(db: Driver, after: number, max = BUILD_BATCH): number | null {
  return db
    .transaction((): number | null => {
      const upTo = (db.prepare('SELECT MAX(rowid) AS m FROM (SELECT rowid FROM traces WHERE rowid > ? ORDER BY rowid LIMIT ?)').get(after, max) as { m: number | null }).m;
      if (upTo === null || upTo === undefined) return null;
      const before = Number((db.prepare(`SELECT COALESCE(MAX(doc_id), 0) AS m FROM ${SEARCH_DOCS_TABLE}`).get() as { m: number }).m);
      const added = db
        .prepare(
          `INSERT INTO ${SEARCH_DOCS_TABLE} (tenant_id, trace_id) SELECT tenant_id, trace_id FROM traces WHERE rowid > ? AND rowid <= ? AND trace_id NOT IN (SELECT trace_id FROM ${SEARCH_DOCS_TABLE}) ORDER BY rowid`,
        )
        .run(after, upTo).changes;
      if (added > 0) {
        db.prepare(INDEX_WHERE('d.doc_id > ?')).run(before);
        db.prepare(`INSERT OR IGNORE INTO ${CJK_PENDING_TABLE} (doc_id) SELECT d.doc_id FROM ${SEARCH_DOCS_TABLE} d WHERE d.doc_id > ? AND ${traceMayHoldCjk('d.trace_id')}`).run(before);
      }
      return Number(upTo);
    })
    .immediate();
}

/** Whether any trace is not in the index yet, or waits to have its CJK streamed. */
export function unindexedRemain(db: Driver): boolean {
  return (
    db.prepare(`SELECT 1 FROM traces WHERE trace_id NOT IN (SELECT trace_id FROM ${SEARCH_DOCS_TABLE}) LIMIT 1`).get() !== undefined ||
    db.prepare(`SELECT 1 FROM ${CJK_PENDING_TABLE} LIMIT 1`).get() !== undefined
  );
}

/** Whether any trace has a CJK stream: searches consult the CJK table only then (and when the query holds CJK). */
export function cjkIndexed(db: Driver): boolean {
  return db.prepare(`SELECT 1 FROM ${CJK_DOCS_TABLE} LIMIT 1`).get() !== undefined;
}

/**
 * Stream the CJK of these indexed traces into the CJK table, in the
 * caller's transaction: each trace's row is replaced (taken out with the
 * text it was given, if it had one) and the text stored beside it, when its
 * fields hold CJK; a trace whose fields hold none is left with no row. The
 * fields are read back as the search reads them (searchableText, and the
 * span text from SQL), so the stream is of exactly the indexed text.
 */
export function indexCjk(db: Driver, docIds: readonly number[]): void {
  if (docIds.length === 0) return;
  const readTrace = db.prepare(`SELECT t.trace_id, t.input, t.output, t.tool_calls, t.metadata FROM ${SEARCH_DOCS_TABLE} d JOIN traces t ON t.trace_id = d.trace_id WHERE d.doc_id = ?`);
  const unindex = db.prepare(`INSERT INTO ${CJK_TABLE} (${CJK_TABLE}, rowid, ${CJK_COLUMNS}) SELECT 'delete', doc_id, ${CJK_COLUMNS} FROM ${CJK_DOCS_TABLE} WHERE doc_id = ?`);
  const forget = db.prepare(`DELETE FROM ${CJK_DOCS_TABLE} WHERE doc_id = ?`);
  const store = db.prepare(`INSERT INTO ${CJK_DOCS_TABLE} (doc_id, ${CJK_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const add = db.prepare(`INSERT INTO ${CJK_TABLE} (rowid, ${CJK_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const done = db.prepare(`DELETE FROM ${CJK_PENDING_TABLE} WHERE doc_id = ?`);
  const parse = (v: unknown): unknown => {
    if (typeof v !== 'string') return undefined;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  };
  for (const docId of docIds) {
    unindex.run(docId);
    forget.run(docId);
    done.run(docId);
    const row = readTrace.get(docId) as { trace_id: string; input: unknown; output: unknown; tool_calls: unknown; metadata: unknown } | undefined;
    if (!row) continue;
    const spans = readSpanText(db, [row.trace_id]).get(row.trace_id)?.text ?? '';
    const fields = searchableText({ input: row.input, output: row.output, tool_calls: parse(row.tool_calls), metadata: parse(row.metadata) }, spans);
    if (!SEARCH_FIELDS.some((f) => hasCjk(fields[f]))) continue;
    const columns: Record<string, string> = {};
    const uni: string[] = [];
    for (const f of ['input', 'output', 'tool_calls', 'metadata', 'spans'] as const) {
      const stream = cjkStream(fields[f]);
      columns[f] = stream ? streamText(stream.bi) : '';
      if (stream && stream.uni.length > 0) uni.push(streamText(stream.uni));
    }
    const values = [columns.input, columns.output, columns.tool_calls, columns.metadata, columns.spans, uni.join(' ')];
    store.run(docId, ...values);
    add.run(docId, ...values);
  }
}

/** One step of streaming the queued traces: up to `max` of them, under one write lock. Returns how many, or null when none wait. */
export function indexCjkPending(db: Driver, max: number): number | null {
  return db
    .transaction((): number | null => {
      const ids = (db.prepare(`SELECT doc_id FROM ${CJK_PENDING_TABLE} ORDER BY doc_id LIMIT ?`).all(max) as Array<{ doc_id: number }>).map((r) => Number(r.doc_id));
      if (ids.length === 0) return null;
      indexCjk(db, ids);
      return ids.length;
    })
    .immediate();
}

const cache = new WeakMap<Driver, boolean>();

/**
 * Whether this connection's SQLite can build the index: FTS5 compiled in,
 * new enough for secure-delete (3.42) and for an ordered group_concat
 * (3.44). Probed by creating the real shape
 * in the connection's temp schema, so the answer is about this build, not a
 * version number.
 */
export function fts5Available(db: Driver): boolean {
  const known = cache.get(db);
  if (known !== undefined) return known;
  let ok = false;
  try {
    db.exec(`CREATE VIRTUAL TABLE temp.iris_fts5_probe USING fts5(x, content = '')`);
    db.exec(`INSERT INTO temp.iris_fts5_probe (iris_fts5_probe, rank) VALUES ('secure-delete', 1)`);
    // The span column joins its values with an ordered group_concat (3.44).
    db.prepare(`SELECT group_concat(x, ',' ORDER BY x) AS g FROM (SELECT 1 AS x)`).get();
    ok = true;
  } catch {
    ok = false;
  } finally {
    try {
      db.exec('DROP TABLE IF EXISTS temp.iris_fts5_probe');
    } catch {
      // Dropping a table the probe never created cannot matter.
    }
  }
  cache.set(db, ok);
  return ok;
}

/** Tests only: answer the probe for this connection without running it, as a build without FTS5 would. */
export function assumeFts5(db: Driver, available: boolean): void {
  cache.set(db, available);
}

function objectExists(db: Driver, type: 'table' | 'trigger', name: string): boolean {
  return db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(type, name) !== undefined;
}

/*
 * Retiring an index. Rebuilding from scratch (an index built before the
 * span column, or one whose triggers a start without FTS5 dropped) used to
 * empty or drop the old index at the start, and dropping it is a rewrite of
 * every one of its pages, zeroed by secure_delete: 1.2 s for 72 MB, measured
 * on the machine in the changelog, while the server was not yet answering.
 * Instead the start renames it, which is instant, and the background build
 * drops it first (dropRetiredIndex), before it indexes a trace: one
 * statement, because FTS5's own tables cannot be emptied a row at a time
 * from outside it, so it is the build's one long step. Until then, the
 * words of a trace deleted in that moment are still in the retired index's
 * pages; the drop zeroes them with the rest.
 */
export const RETIRED_TABLE = 'trace_search_retired';

/** Take the index out of use: its triggers dropped, renamed for the build to erase, its docs rows gone. In the caller's transaction. */
function retireIndex(db: Driver): void {
  for (const t of ALL_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
  // One retired index at a time: a second retirement before the first was erased drops that one now.
  for (const t of [RETIRED_TABLE, RETIRED_CJK_TABLE, RETIRED_CJK_DOCS_TABLE]) if (objectExists(db, 'table', t)) db.exec(`DROP TABLE ${t}`);
  db.exec(`ALTER TABLE ${SEARCH_TABLE} RENAME TO ${RETIRED_TABLE}`);
  if (objectExists(db, 'table', CJK_TABLE)) db.exec(`ALTER TABLE ${CJK_TABLE} RENAME TO ${RETIRED_CJK_TABLE}`);
  if (objectExists(db, 'table', CJK_DOCS_TABLE)) db.exec(`ALTER TABLE ${CJK_DOCS_TABLE} RENAME TO ${RETIRED_CJK_DOCS_TABLE}`);
  db.exec(`DROP TABLE IF EXISTS ${CJK_PENDING_TABLE}`);
  db.exec(`DELETE FROM ${SEARCH_DOCS_TABLE}`);
}

/** Drop the index retired at the start, if there is one; whether there was. */
export function dropRetiredIndex(db: Driver): boolean {
  return db
    .transaction((): boolean => {
      const retired = [RETIRED_TABLE, RETIRED_CJK_TABLE, RETIRED_CJK_DOCS_TABLE].filter((t) => objectExists(db, 'table', t));
      for (const t of retired) db.exec(`DROP TABLE ${t}`);
      return retired.length > 0;
    })
    .immediate();
}

/** Whether the index has the span column: false for one built before #683. Read from its declaration, which needs no FTS5. */
function hasSpanColumn(db: Driver): boolean {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(SEARCH_TABLE) as { sql: string } | undefined;
  return row !== undefined && /\bspans\b/.test(row.sql);
}

/** Where one span's values sit in a trace's span text. */
export interface SpanTextPart {
  span_id: string;
  name: string;
  start: number;
  end: number;
}

export interface SpanText {
  text: string;
  parts: SpanTextPart[];
}

/**
 * The span text of these traces, keyed by trace id, with which span each
 * stretch came from: spanValuesSql's rows joined as the index column joins
 * them, so the snippet and the search without FTS5 read the same text the
 * index holds. Needs no FTS5.
 */
export function readSpanText(db: Driver, traceIds: readonly string[]): Map<string, SpanText> {
  const out = new Map<string, SpanText>();
  if (traceIds.length === 0) return out;
  // One trace per run of one prepared statement: 138 µs a trace against 246 for one statement over 500 (its GROUP BY sorts them all together).
  const read = db.prepare(`${spanValuesSql('s.trace_id = ?')} ORDER BY k`);
  // The id appears once in each half of spanLeaves' UNION.
  const rows = traceIds.flatMap((id) => read.all(id, id) as Array<{ trace_id: string; span_id: string; name: string; v: string }>);
  for (const r of rows) {
    let entry = out.get(r.trace_id);
    if (!entry) {
      entry = { text: '', parts: [] };
      out.set(r.trace_id, entry);
    }
    if (entry.text.length > 0) entry.text += SPAN_TEXT_SEPARATOR;
    const start = entry.text.length;
    entry.text += r.v;
    const last = entry.parts[entry.parts.length - 1];
    if (last && last.span_id === r.span_id) last.end = entry.text.length;
    else entry.parts.push({ span_id: r.span_id, name: r.name, start, end: entry.text.length });
  }
  // SQLite's substr counts characters, not UTF-16 units: cut the same way.
  for (const entry of out.values()) {
    const chars = Array.from(entry.text);
    if (chars.length <= SPAN_TEXT_MAX_CHARS) continue;
    entry.text = chars.slice(0, SPAN_TEXT_MAX_CHARS).join('');
    entry.parts = entry.parts.filter((p) => p.start < entry.text.length).map((p) => ({ ...p, end: Math.min(p.end, entry.text.length) }));
  }
  return out;
}

/**
 * Create the index, empty. The migration's body; idempotent. The traces
 * already stored are indexed after the server has started, in steps
 * (indexNextBatch), never here: on a large store the build takes seconds
 * (20.4 s at 100,000 traces on the machine in the changelog), and a start
 * that waited for it would leave a stdio MCP client timing out on connect.
 */
export function installSearchIndex(db: Driver): void {
  db.exec(CREATE_TABLES);
  db.exec(CREATE_CJK_TABLES);
  db.exec(`INSERT INTO ${SEARCH_TABLE} (${SEARCH_TABLE}, rank) VALUES ('secure-delete', 1)`);
  db.exec(`INSERT INTO ${CJK_TABLE} (${CJK_TABLE}, rank) VALUES ('secure-delete', 1)`);
  db.exec(CREATE_TRIGGERS);
}

/**
 * `ready`: every trace is in the index and searches use it. `building`: the
 * index exists and is being filled; searches read the traces until it is
 * done, so they are slower but never miss a trace. `unavailable`: no FTS5.
 */
export type SearchIndexState = 'ready' | 'building' | 'unavailable';

/**
 * Run at every start, after the migrations. Brings the index to a state the
 * triggers and the adapter can keep, whatever happened since the last start:
 *
 *   - FTS5 here, index missing (the migration ran on a build without FTS5):
 *     create it; `building`.
 *   - FTS5 here, triggers missing (a start without FTS5 dropped them, and
 *     deletes and updates since then were not applied to the index), or more
 *     docs rows than traces: empty the index and start over; `building`.
 *   - FTS5 here, fewer docs rows than traces (the upgrade, or a trace
 *     inserted by something other than the adapter): `building`.
 *   - every trace indexed: `ready`.
 *
 * Nothing here indexes a trace: that is the caller's background build.
 *   - no FTS5, triggers present: drop them, so deletes and updates keep
 *     working; search reads the traces instead.
 */
export function reconcileSearchIndex(db: Driver, available = fts5Available(db)): SearchIndexState {
  let state: SearchIndexState = 'unavailable';
  // Checked and repaired under one write lock, so two processes starting on one file cannot both rebuild.
  db.transaction(() => {
    const hasTable = objectExists(db, 'table', SEARCH_TABLE);
    const triggersPresent = TRIGGERS.filter((t) => objectExists(db, 'trigger', t)).length;
    if (!available) {
      for (const t of ALL_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
      return;
    }
    if (hasTable && !hasSpanColumn(db)) {
      // Built before the span column: FTS5 cannot add one, so retire the index and build a new one.
      retireIndex(db);
      installSearchIndex(db);
      state = 'building';
      return;
    }
    if (hasTable && !objectExists(db, 'table', CJK_TABLE)) {
      // Built before the CJK stream: the index stays; its triggers are replaced by ones that keep the stream, and every trace that could hold CJK is queued.
      for (const t of ALL_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
      installSearchIndex(db);
      db.exec(`INSERT OR IGNORE INTO ${CJK_PENDING_TABLE} (doc_id) SELECT d.doc_id FROM ${SEARCH_DOCS_TABLE} d WHERE ${traceMayHoldCjk('d.trace_id')}`);
    }
    if (!hasTable) installSearchIndex(db);
    const counts = db
      .prepare(`SELECT (SELECT COUNT(*) FROM traces) AS traces, (SELECT COUNT(*) FROM ${SEARCH_DOCS_TABLE}) AS docs`)
      .get() as { traces: number; docs: number };
    const traces = Number(counts.traces);
    const docs = Number(counts.docs);
    if (hasTable && (triggersPresent < TRIGGERS.length || docs > traces)) {
      retireIndex(db);
      installSearchIndex(db);
      state = 'building';
      return;
    }
    const pending = db.prepare(`SELECT 1 FROM ${CJK_PENDING_TABLE} LIMIT 1`).get() !== undefined;
    state = docs < traces || pending || objectExists(db, 'table', RETIRED_TABLE) ? 'building' : 'ready';
  }).immediate();
  return state;
}

/**
 * Index traces the adapter has just inserted, with their spans, in the
 * caller's transaction: their docs rows, then their words in one statement,
 * through the same SQL expression a delete later recomputes them with. Run
 * after the batch's spans are written: a docs row written before a span
 * would make the span triggers re-index the trace once per span.
 */
export function indexInsertedTraces(db: Driver, tenantId: string, traceIds: readonly string[]): void {
  if (traceIds.length === 0) return;
  const before = Number((db.prepare(`SELECT COALESCE(MAX(doc_id), 0) AS m FROM ${SEARCH_DOCS_TABLE}`).get() as { m: number }).m);
  const addDoc = db.prepare(`INSERT INTO ${SEARCH_DOCS_TABLE} (tenant_id, trace_id) VALUES (?, ?)`);
  for (const id of traceIds) addDoc.run(tenantId, id);
  db.prepare(INDEX_WHERE('d.doc_id > ?')).run(before);
}

/**
 * Deleting many traces at once — the retention sweep, --purge. Run `remove`
 * (the DELETE, whose trigger takes each trace out of the index) inside the
 * caller's transaction, choosing how the words are erased:
 *
 *   - every trace indexed is going: empty the index outright ('delete-all')
 *     and the trigger has nothing left to do;
 *   - more than 1 in PER_ROW_LIMIT of the index is going: switch
 *     secure-delete off for the delete and rewrite the index once afterwards
 *     ('optimize' merges every segment into one, dropping the deleted
 *     entries; the freed pages are zeroed by the database's secure_delete).
 *     Measured on the machine in the changelog: a delete with secure-delete
 *     cost 2.6 ms a row against 0.12 ms without, and 'optimize' over an
 *     index of 97,000 traces took 2.0 s, after which none of the deleted
 *     words were left in the file;
 *   - otherwise: row by row, each erased as it goes.
 *
 * `going` is how many traces the DELETE will remove.
 */
const PER_ROW_LIMIT = 125;
export function bulkIndexDelete<T>(db: Driver, going: number, remove: () => T): T {
  if (going === 0 || !objectExists(db, 'table', SEARCH_TABLE)) return remove();
  const indexed = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${SEARCH_DOCS_TABLE}`).get() as { n: number }).n);
  if (indexed === 0) return remove();
  const tables = objectExists(db, 'table', CJK_TABLE) ? [SEARCH_TABLE, CJK_TABLE] : [SEARCH_TABLE];
  if (going >= indexed) {
    for (const t of tables) db.exec(`INSERT INTO ${t} (${t}) VALUES ('delete-all')`);
    if (tables.length > 1) db.exec(`DELETE FROM ${CJK_DOCS_TABLE}; DELETE FROM ${CJK_PENDING_TABLE};`);
    db.exec(`DELETE FROM ${SEARCH_DOCS_TABLE}`);
    return remove();
  }
  if (going * PER_ROW_LIMIT <= indexed) return remove();
  for (const t of tables) db.exec(`INSERT INTO ${t} (${t}, rank) VALUES ('secure-delete', 0)`);
  try {
    const out = remove();
    for (const t of tables) db.exec(`INSERT INTO ${t} (${t}) VALUES ('optimize')`);
    return out;
  } finally {
    for (const t of tables) db.exec(`INSERT INTO ${t} (${t}, rank) VALUES ('secure-delete', 1)`);
  }
}
