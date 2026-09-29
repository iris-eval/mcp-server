import type { Driver } from '../driver.js';
import { fts5Available, installSearchIndex } from '../search-index.js';

/*
 * Full-text search over traces (#7).
 *
 * The FTS5 index over each trace's input, output, tool-call values and
 * metadata values, the table that gives every trace a stable integer id in
 * it, and the triggers that keep it in step with the traces table on every
 * update and delete. The index is created empty: the traces already stored
 * are indexed after the server has started, in steps, while searches read
 * the traces (a start that waited would keep a stdio MCP client waiting;
 * 20.4 s at 100,000 traces). The design and the reasons for it:
 * src/storage/search-index.ts.
 *
 * On a SQLite without FTS5 this creates nothing and is still recorded as
 * applied: the schema of the rest of the database does not depend on it,
 * and the adapter builds the index on the first start that has FTS5.
 */
export const id = '015-trace-search';

/*
 * The oldest release that can use a database with the index: this one.
 * Checked by running the released 0.19.0 against a file this migration had
 * been applied to (with its ledger row taken out, since 0.19.0 refuses any
 * migration it does not know): its deletes, the retention sweep, the
 * metadata patch and a span added to an indexed trace all kept the index
 * right through the triggers, and FTS5's integrity-check passed. But 0.19.0
 * inserts traces without indexing them, because inserts are indexed by the
 * adapter and not by a trigger (search-index.ts says why), and a 0.20.0
 * server running beside it would answer searches from an index that lacked
 * them. 0.20.0 now notices and indexes such traces (the adapter's
 * catchUpOtherWriters), but an older release writing into the file is not
 * something to invite: the floor stays at 0.20.0, which is also what
 * 0.19.0's own guard enforces.
 */
export const compatFloor = '0.20.0';

export function up(db: Driver): void {
  if (fts5Available(db)) installSearchIndex(db);
}
