/*
 * WAL checkpoints run on a worker thread, not on the event loop
 * (src/storage/checkpointer.ts).
 *
 * Once the worker is up, the adapter's own connection stops checkpointing
 * (wal_autocheckpoint 0) and the worker copies the log into the file on its
 * own; checkpoint() truncates the log there and answers when it is done;
 * and if the worker stops, the adapter's connection checkpoints by itself
 * again and says so. Run on this cell's driver, so the CI matrix covers
 * both.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import type { Checkpointer } from '../../../src/storage/checkpointer.js';
import type { Driver } from '../../../src/storage/driver.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import { CELL_DRIVER } from './fts5-here.js';

vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
const open: SqliteAdapter[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Log = Array<['info' | 'warn', string]>;

async function store(log: Log = []): Promise<{ s: SqliteAdapter; path: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'iris-ckpt-'));
  dirs.push(dir);
  const path = join(dir, 'iris.db');
  const s = new SqliteAdapter(path, { driver: CELL_DRIVER, log: (level, line) => void log.push([level, line]) });
  open.push(s);
  await s.initialize();
  return { s, path };
}

const worker = (s: SqliteAdapter) => (s as unknown as { checkpointer?: Checkpointer }).checkpointer;
const dbOf = (s: SqliteAdapter) => (s as unknown as { db: Driver }).db;
const autocheckpoint = (s: SqliteAdapter) => {
  const row = dbOf(s).pragma('wal_autocheckpoint') as { wal_autocheckpoint: number } | Array<{ wal_autocheckpoint: number }>;
  return Number((Array.isArray(row) ? row[0] : row).wal_autocheckpoint);
};
const size = (file: string) => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};
const traces = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ trace_id: `t-${from + i}`, agent_name: 'a', output: `answer ${from + i} ${'text '.repeat(200)}`, timestamp: new Date().toISOString() }));

describe('WAL checkpoints on a worker thread', () => {
  it('takes checkpointing off the adapter’s connection, and copies the log into the file by itself', async () => {
    const { s, path } = await store();
    expect(await worker(s)!.started).toBe(true);
    expect(autocheckpoint(s)).toBe(0);
    const before = size(path);
    // Well past 1,000 pages (4 MB) with or without FTS5: a connection checkpointing by itself would have copied some of it inside a commit.
    for (let i = 0; i < 8; i += 1) await s.insertTraces(LOCAL_TENANT, traces(500, i * 500));
    expect(size(`${path}-wal`)).toBeGreaterThan(4 * 1024 * 1024);
    const deadline = Date.now() + 10_000;
    while (size(path) <= before + 2 * 1024 * 1024 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    // The file holds the traces: the worker checkpointed while this connection never did.
    expect(size(path)).toBeGreaterThan(before + 2 * 1024 * 1024);
    expect(autocheckpoint(s)).toBe(0);
  });

  it('checkpoint() truncates the log on the worker and answers when it is done', async () => {
    const { s, path } = await store();
    expect(await worker(s)!.started).toBe(true);
    await s.insertTraces(LOCAL_TENANT, traces(200));
    expect(size(`${path}-wal`)).toBeGreaterThan(0);
    await s.checkpoint();
    expect(size(`${path}-wal`)).toBe(0);
    expect((await s.queryTraces(LOCAL_TENANT, { limit: 1 })).total).toBe(200);
  });

  it('when the worker stops, the adapter’s connection checkpoints by itself again, and says so', async () => {
    const log: Log = [];
    const { s, path } = await store(log);
    const w = worker(s)!;
    expect(await w.started).toBe(true);
    await (w as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
    const deadline = Date.now() + 5_000;
    while (autocheckpoint(s) === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(autocheckpoint(s)).toBe(1000);
    expect(w.active).toBe(false);
    expect(log).toContainEqual(['warn', expect.stringMatching(/^WAL checkpoints run on the server's own connection again/)]);
    await s.insertTraces(LOCAL_TENANT, traces(50));
    await s.checkpoint();
    expect(size(`${path}-wal`)).toBe(0);
  });

  it('a database in memory has no worker', async () => {
    const s = new SqliteAdapter(':memory:', { driver: CELL_DRIVER });
    open.push(s);
    await s.initialize();
    expect(worker(s)).toBeUndefined();
  });
});
