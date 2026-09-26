import type { Driver } from '../driver.js';
import { fts5Available, installSearchIndex } from '../search-index.js';

/*
 * Full-text search over traces (#7).
 *
 * The FTS5 index over each trace's input, output, tool-call values and
 * metadata values, the table that gives every trace a stable integer id in
 * it, and the triggers that keep it in step with the traces table on every
 * insert, update and delete. Existing traces are indexed here, in the same
 * transaction. The design and the reasons for it: src/storage/search-index.ts.
 *
 * On a SQLite without FTS5 this creates nothing and is still recorded as
 * applied: the schema of the rest of the database does not depend on it,
 * and the adapter builds the index on the first start that has FTS5.
 */
export const id = '015-trace-search';

export function up(db: Driver): void {
  if (fts5Available(db)) installSearchIndex(db);
}
