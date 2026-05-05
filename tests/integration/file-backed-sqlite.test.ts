import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { sampleTrace, minimalTrace } from '../fixtures/sample-traces.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';

/*
 * File-backed SQLite integration test.
 *
 * The other integration tests use `:memory:` which uses the same SQLite
 * driver but skips file I/O, WAL/journal init, and the cross-connection
 * read path. This single test exercises a real on-disk database with
 * two adapter instances pointing at the same file, which catches WAL
 * setup bugs and cross-connection visibility regressions that
 * `:memory:` cannot.
 */
describe('File-backed SQLite', () => {
  let tmpDir: string | undefined;
  let writer: SqliteAdapter | undefined;
  let reader: SqliteAdapter | undefined;

  afterEach(async () => {
    if (writer) await writer.close();
    if (reader) await reader.close();
    writer = undefined;
    reader = undefined;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('persists traces across two adapter instances on the same file', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'iris-sqlite-'));
    const dbPath = join(tmpDir, 'iris.db');

    writer = new SqliteAdapter(dbPath);
    await writer.initialize();
    await writer.insertTrace(LOCAL_TENANT, sampleTrace);
    await writer.insertTrace(LOCAL_TENANT, minimalTrace);

    reader = new SqliteAdapter(dbPath);
    await reader.initialize();
    const result = await reader.queryTraces(LOCAL_TENANT, {});

    expect(result.total).toBe(2);
    const ids = result.traces.map((t) => t.trace_id).sort();
    expect(ids).toEqual([sampleTrace.trace_id, minimalTrace.trace_id].sort());
  });
});
