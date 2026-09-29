/*
 * The reads name the indexes they walk (INDEXED BY, #711), and a statement
 * that names a missing index fails instead of choosing another plan. So
 * every index the adapter names must exist once the migrations have run on
 * a new file, with or without FTS5 (on a file with traces, migration 019's
 * are built after the start, and the reads name them only once they exist:
 * read-paths.ts): a migration that drops or renames one fails here, in the
 * release that makes the change, and sets its compatFloor to that release
 * (migration 019's header).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ADAPTER = readFileSync(fileURLToPath(new URL('../../../src/storage/sqlite-adapter.ts', import.meta.url)), 'utf8');
// Named inline (INDEXED BY idx_...) or held in a string the query interpolates.
const NAMED = [...new Set([...ADAPTER.matchAll(/\b(idx_[a-z0-9_]+)\b/g)].map((m) => m[1]))].sort();

describe('every index a read names exists after the migrations', () => {
  it('finds the names it checks', () => {
    expect(ADAPTER).toMatch(/INDEXED BY \$\{/);
    expect(NAMED).toEqual(expect.arrayContaining(['idx_traces_tenant_agent_timestamp', 'idx_traces_tenant_timestamp_cover', 'idx_spans_tenant_error']));
  });

  for (const fts5 of [true, false]) {
    it(`on a new file ${fts5 ? 'with' : 'without'} FTS5`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'iris-indexed-by-'));
      dirs.push(dir);
      const path = join(dir, 'iris.db');
      const store = new SqliteAdapter(path, { fts5, searchWorker: false });
      await store.initialize();
      await store.close();
      const db = new Database(path, { readonly: true });
      const present = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((r) => r.name));
      db.close();
      expect(NAMED.filter((name) => !present.has(name))).toEqual([]);
    });
  }
});
