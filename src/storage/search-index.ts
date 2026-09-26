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
 * tool call. The extraction is one SQL expression (indexRow below) used by
 * every write, so the values a delete hands FTS5 are the values the insert
 * gave it.
 *
 * Staying in sync: inserts are written by the adapter, updates and deletes
 * by triggers.
 *   - Deletes and updates are triggers because a trace leaves the table by
 *     several routes — delete_trace, the retention sweep, --purge, a
 *     hand-run DELETE by an operator — and changes by one (the metadata
 *     patch). A trigger runs on every route, in the same transaction,
 *     including routes written after this file.
 *   - Inserts are not, because they cannot be fast from a trigger: SQLite
 *     runs each trigger statement inside a statement savepoint, and FTS5
 *     flushes its pending terms to a new segment at every savepoint. A batch
 *     of 1,000 traces became 1,000 one-document segments and a merge storm:
 *     255 µs per trace from a trigger against 76 µs from the same statement
 *     run by the adapter (measured on the machine in the changelog). There
 *     is one insert route (insertTraces), and it writes the index in the
 *     transaction that writes the trace. A trace inserted any other way has
 *     no docs row, so the delete trigger leaves the index alone for it, and
 *     the next start indexes it (reconcileSearchIndex).
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
 * index is rebuilt from scratch on the next start that can.
 */
import type { Driver } from './driver.js';

export const SEARCH_TABLE = 'trace_search';
export const SEARCH_DOCS_TABLE = 'trace_search_docs';
const TRIGGERS = ['trace_search_au', 'trace_search_ad'] as const;

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
 * bm25 column weights, in column order: input, output, tool_calls, metadata.
 * A word in what the agent was asked or said counts twice a word in a tool
 * argument or a metadata value, which carry ids and boilerplate.
 */
export const BM25_WEIGHTS = '1.0, 1.0, 0.5, 0.5';

/** String and number leaves of a JSON column; text that is not JSON is indexed as it is. */
function jsonText(col: string): string {
  return `CASE WHEN json_valid(${col}) THEN (SELECT group_concat(value, ' ') FROM json_tree(${col}) WHERE type IN ('text', 'integer', 'real')) ELSE ${col} END`;
}

/**
 * The four indexed values of a trace, in column order: the one expression
 * every write uses. `ref` names a row (t, OLD, NEW); with `?`, the values are
 * bound instead — each JSON column three times, once per mention in
 * jsonText, in the order boundIndexValues gives them.
 */
function indexRow(ref: string): string {
  if (ref === '?') return `?, ?, ${jsonText('?')}, ${jsonText('?')}`;
  return `${ref}.input, ${ref}.output, ${jsonText(`${ref}.tool_calls`)}, ${jsonText(`${ref}.metadata`)}`;
}

/** The stored values of a trace, as insertTraces binds them, for indexRow('?'). */
export interface StoredTraceText {
  traceId: string;
  input: string | null;
  output: string | null;
  toolCalls: string | null;
  metadata: string | null;
}

function boundIndexValues(t: StoredTraceText): unknown[] {
  return [t.input, t.output, t.toolCalls, t.toolCalls, t.toolCalls, t.metadata, t.metadata, t.metadata];
}

const COLUMNS = 'input, output, tool_calls, metadata';

/** Index the traces whose docs rows match `where` (over d, the docs row, and t, the trace). */
const INDEX_WHERE = (where: string) =>
  `INSERT INTO ${SEARCH_TABLE} (rowid, ${COLUMNS}) SELECT d.doc_id, ${indexRow('t')} FROM ${SEARCH_DOCS_TABLE} d JOIN traces t ON t.trace_id = d.trace_id WHERE ${where}`;

/** The 'delete' command: FTS5 needs the values the row was indexed with, recomputed from OLD. Nothing when the trace was never indexed. */
const DELETE_OLD = `INSERT INTO ${SEARCH_TABLE} (${SEARCH_TABLE}, rowid, ${COLUMNS})
      SELECT 'delete', doc_id, ${indexRow('OLD')} FROM ${SEARCH_DOCS_TABLE} WHERE trace_id = OLD.trace_id`;

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

const CREATE_TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS trace_search_au AFTER UPDATE OF input, output, tool_calls, metadata, trace_id, tenant_id ON traces BEGIN
    ${DELETE_OLD};
    UPDATE ${SEARCH_DOCS_TABLE} SET tenant_id = NEW.tenant_id, trace_id = NEW.trace_id WHERE trace_id = OLD.trace_id;
    INSERT INTO ${SEARCH_TABLE} (rowid, ${COLUMNS}) SELECT doc_id, ${indexRow('NEW')} FROM ${SEARCH_DOCS_TABLE} WHERE trace_id = NEW.trace_id;
  END;
  CREATE TRIGGER IF NOT EXISTS trace_search_ad AFTER DELETE ON traces BEGIN
    ${DELETE_OLD};
    DELETE FROM ${SEARCH_DOCS_TABLE} WHERE trace_id = OLD.trace_id;
  END;
`;

/** Index every trace that has no docs row yet: ids first, then the words, in two statements. */
function backfill(db: Driver): void {
  const before = Number((db.prepare(`SELECT COALESCE(MAX(doc_id), 0) AS m FROM ${SEARCH_DOCS_TABLE}`).get() as { m: number }).m);
  db.exec(
    `INSERT INTO ${SEARCH_DOCS_TABLE} (tenant_id, trace_id) SELECT tenant_id, trace_id FROM traces WHERE trace_id NOT IN (SELECT trace_id FROM ${SEARCH_DOCS_TABLE}) ORDER BY rowid`,
  );
  db.prepare(INDEX_WHERE('d.doc_id > ?')).run(before);
}

const cache = new WeakMap<Driver, boolean>();

/**
 * Whether this connection's SQLite can build the index: FTS5 compiled in,
 * and new enough for secure-delete (3.42). Probed by creating the real shape
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

/** Create the index and fill it from the traces already stored. The migration's body; idempotent. */
export function installSearchIndex(db: Driver): void {
  db.exec(CREATE_TABLES);
  db.exec(`INSERT INTO ${SEARCH_TABLE} (${SEARCH_TABLE}, rank) VALUES ('secure-delete', 1)`);
  backfill(db);
  db.exec(CREATE_TRIGGERS);
}

export type SearchIndexState = 'ready' | 'unavailable';

/**
 * Run at every start, after the migrations. Brings the index to a state the
 * triggers and the adapter can keep, whatever happened since the last start:
 *
 *   - FTS5 here, index missing (the migration ran on a build without FTS5):
 *     build it.
 *   - FTS5 here, triggers missing (a start without FTS5 dropped them, and
 *     deletes and updates since then were not applied to the index), or more
 *     docs rows than traces: drop the index rows and rebuild from the traces.
 *   - FTS5 here, fewer docs rows than traces (a trace inserted by something
 *     other than the adapter): index the missing ones.
 *   - no FTS5, triggers present: drop them, so deletes and updates keep
 *     working; search reads the traces instead.
 */
export function reconcileSearchIndex(db: Driver, available = fts5Available(db)): SearchIndexState {
  // Checked and repaired under one write lock, so two processes starting on one file cannot both rebuild.
  db.transaction(() => {
    const hasTable = objectExists(db, 'table', SEARCH_TABLE);
    const triggersPresent = TRIGGERS.filter((t) => objectExists(db, 'trigger', t)).length;
    if (!available) {
      for (const t of TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
      return;
    }
    if (!hasTable) {
      installSearchIndex(db);
      return;
    }
    const counts = db
      .prepare(`SELECT (SELECT COUNT(*) FROM traces) AS traces, (SELECT COUNT(*) FROM ${SEARCH_DOCS_TABLE}) AS docs`)
      .get() as { traces: number; docs: number };
    const traces = Number(counts.traces);
    const docs = Number(counts.docs);
    if (triggersPresent < TRIGGERS.length || docs > traces) {
      for (const t of TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
      db.exec(`INSERT INTO ${SEARCH_TABLE} (${SEARCH_TABLE}) VALUES ('delete-all')`);
      db.exec(`DELETE FROM ${SEARCH_DOCS_TABLE}`);
      installSearchIndex(db);
    } else if (docs < traces) {
      backfill(db);
    }
  }).immediate();
  return available ? 'ready' : 'unavailable';
}

/**
 * Index a trace the adapter has just inserted, in the caller's transaction:
 * its docs row, then its words. The values are the ones just written to the
 * row, run through the same SQL expression a delete later recomputes them
 * with — bound rather than read back, which saves a join per trace.
 */
export function searchIndexWriter(db: Driver): (tenantId: string, trace: StoredTraceText) => void {
  const addDoc = db.prepare(`INSERT INTO ${SEARCH_DOCS_TABLE} (tenant_id, trace_id) VALUES (?, ?)`);
  const addWords = db.prepare(`INSERT INTO ${SEARCH_TABLE} (rowid, ${COLUMNS}) VALUES (?, ${indexRow('?')})`);
  return (tenantId, trace) => {
    const { lastInsertRowid } = addDoc.run(tenantId, trace.traceId);
    addWords.run(Number(lastInsertRowid), ...boundIndexValues(trace));
  };
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
  if (going >= indexed) {
    db.exec(`INSERT INTO ${SEARCH_TABLE} (${SEARCH_TABLE}) VALUES ('delete-all')`);
    db.exec(`DELETE FROM ${SEARCH_DOCS_TABLE}`);
    return remove();
  }
  if (going * PER_ROW_LIMIT <= indexed) return remove();
  db.exec(`INSERT INTO ${SEARCH_TABLE} (${SEARCH_TABLE}, rank) VALUES ('secure-delete', 0)`);
  try {
    const out = remove();
    db.exec(`INSERT INTO ${SEARCH_TABLE} (${SEARCH_TABLE}) VALUES ('optimize')`);
    return out;
  } finally {
    db.exec(`INSERT INTO ${SEARCH_TABLE} (${SEARCH_TABLE}, rank) VALUES ('secure-delete', 1)`);
  }
}
