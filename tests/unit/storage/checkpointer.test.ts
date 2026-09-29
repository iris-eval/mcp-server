/*
 * WAL checkpoints run on a worker thread, not on the event loop
 * (src/storage/checkpointer.ts).
 *
 * The worker starts at the store's first write, not at open. Once it is
 * up, the adapter's own connection keeps only a tail checkpoint
 * (wal_autocheckpoint TAIL_CHECKPOINT_PAGES) and the worker copies the log
 * into the file on its own; the log still starts over under writes that
 * never pause; a background step that finds the log past
 * STEP_TRUNCATE_PAGES has the worker empty it first, so the adapter's own
 * checkpoint stays out of the steps; checkpoint() truncates the log there
 * and answers when it is done; if the worker stops, the adapter's connection checkpoints by
 * itself again and says so, and the next write starts a new one; and
 * close() lets it end on its own.
 * Run on this cell's driver, so the CI matrix covers both.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { Checkpointer, STEP_TRUNCATE_PAGES, TAIL_CHECKPOINT_PAGES } from '../../../src/storage/checkpointer.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import type { Driver } from '../../../src/storage/driver.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import { CELL_DRIVER } from './fts5-here.js';

vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
const open: SqliteAdapter[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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
  it('starts at the first write, not at open: a store that is only read starts no thread', async () => {
    const { s } = await store();
    await s.queryTraces(LOCAL_TENANT, { limit: 1 });
    expect(worker(s)).toBeUndefined();
    await s.insertTraces(LOCAL_TENANT, traces(1));
    expect(await worker(s)!.started).toBe(true);
  });

  it('leaves the adapter’s connection only the tail checkpoint, and copies the log into the file by itself', async () => {
    const { s, path } = await store();
    await s.insertTraces(LOCAL_TENANT, traces(1, 100_000));
    expect(await worker(s)!.started).toBe(true);
    expect(autocheckpoint(s)).toBe(TAIL_CHECKPOINT_PAGES);
    const before = size(path);
    // Past 1,000 pages (4 MB) with or without FTS5, under TAIL_CHECKPOINT_PAGES (64 MB): the adapter's connection copies none of it.
    for (let i = 0; i < 8; i += 1) await s.insertTraces(LOCAL_TENANT, traces(500, i * 500));
    expect(size(`${path}-wal`)).toBeGreaterThan(4 * 1024 * 1024);
    const deadline = Date.now() + 10_000;
    while (size(path) <= before + 2 * 1024 * 1024 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    // The file holds the traces: the worker copied them.
    expect(size(path)).toBeGreaterThan(before + 2 * 1024 * 1024);
    expect(autocheckpoint(s)).toBe(TAIL_CHECKPOINT_PAGES);
  });

  it('checkpoint() truncates the log on the worker and answers when it is done', async () => {
    const { s, path } = await store();
    await s.insertTraces(LOCAL_TENANT, traces(200));
    expect(await worker(s)!.started).toBe(true);
    await s.insertTraces(LOCAL_TENANT, traces(10, 1000));
    expect(size(`${path}-wal`)).toBeGreaterThan(0);
    await s.checkpoint();
    expect(size(`${path}-wal`)).toBe(0);
    expect((await s.queryTraces(LOCAL_TENANT, { limit: 1 })).total).toBe(210);
  });

  it('when the worker stops, the adapter’s connection checkpoints by itself again and says so, and the next write starts a new one', async () => {
    const log: Log = [];
    const { s, path } = await store(log);
    await s.insertTraces(LOCAL_TENANT, traces(1, 100_000));
    const w = worker(s)!;
    expect(await w.started).toBe(true);
    await (w as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
    const deadline = Date.now() + 5_000;
    while (autocheckpoint(s) === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(autocheckpoint(s)).toBe(1000);
    expect(w.active).toBe(false);
    expect(log).toContainEqual(['warn', expect.stringMatching(/^WAL checkpoints run on the server's own connection again/)]);
    await s.insertTraces(LOCAL_TENANT, traces(50));
    // A new thread, started by that write.
    const next = worker(s)!;
    expect(next).not.toBe(w);
    expect(await next.started).toBe(true);
    expect(autocheckpoint(s)).toBe(TAIL_CHECKPOINT_PAGES);
    await s.checkpoint();
    expect(size(`${path}-wal`)).toBe(0);
  });

  it('close() lets the thread close its connection and end on its own', async () => {
    const { s } = await store();
    await s.insertTraces(LOCAL_TENANT, traces(1));
    const w = worker(s)!;
    expect(await w.started).toBe(true);
    const thread = (w as unknown as { worker: { once(e: 'exit', f: (code: number) => void): void } }).worker;
    const exited = new Promise<number>((r) => thread.once('exit', r));
    await s.close();
    open.splice(open.indexOf(s), 1);
    // Ended by itself: a terminated thread exits with code 1.
    expect(await exited).toBe(0);
  });

  it('keeps the log short under writes that never pause, where the worker alone let it grow with every write', async () => {
    /** One trace per write, back to back, over many of the worker's ticks; the log's size after, in MB. A count, not a time: the log grows by the write. */
    const write = async (s: SqliteAdapter, path: string, n: number): Promise<number> => {
      for (let i = 0; i < n; i += 1) {
        await s.insertTrace(LOCAL_TENANT, traces(1, 1_000_000 + i)[0]);
        await new Promise((r) => setImmediate(r));
      }
      return size(`${path}-wal`) / 2 ** 20;
    };
    const tailMb = (TAIL_CHECKPOINT_PAGES * 4096) / 2 ** 20;
    const tail = await store();
    await tail.s.insertTraces(LOCAL_TENANT, traces(1, 900_000));
    expect(await worker(tail.s)!.started).toBe(true);
    // With the tail checkpoint: about TAIL_CHECKPOINT_PAGES (64 MB) of log, more while the worker's own copy holds the checkpoint lock.
    const bounded = await write(tail.s, tail.path, 2_500);
    expect(bounded).toBeLessThan(2 * tailMb);
    // Anti-theater: the same writes with the adapter's own checkpoint off, the worker alone, as #727 had it: about 235 MB.
    const alone = await store();
    await alone.s.insertTraces(LOCAL_TENANT, traces(1, 900_000));
    expect(await worker(alone.s)!.started).toBe(true);
    dbOf(alone.s).pragma('wal_autocheckpoint = 0');
    const unbounded = await write(alone.s, alone.path, 2_500);
    expect(unbounded).toBeGreaterThan(2 * tailMb);
  });

  it('has the worker empty the log before a background step that finds it past STEP_TRUNCATE_PAGES, so the adapter’s own checkpoint stays out of the steps', async () => {
    // 8,000 evaluations with no stored risk estimate, as 0.19.0 left them: the fill after the start rewrites every row, more log than TAIL_CHECKPOINT_PAGES (the anti-theater half shows it).
    const seed = await store();
    const result = await new EvalEngine().evaluateAll({ output: 'The order shipped on Monday and should arrive by Thursday.', input: 'Where is my order?' });
    await seed.s.insertEvalResult(LOCAL_TENANT, { ...result, id: 'e-0', trace_id: undefined });
    const db = dbOf(seed.s);
    const cols = (db.prepare("SELECT name FROM pragma_table_info('eval_results') WHERE name <> 'id'").all() as Array<{ name: string }>).map((c) => c.name).join(', ');
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 7999) INSERT INTO eval_results (id, ${cols}) SELECT 'e-' || i, ${cols} FROM n, (SELECT * FROM eval_results WHERE id = 'e-0')`);
    db.exec('UPDATE eval_results SET risk_estimate = NULL, risk_version = NULL');
    const pageBytes = Number((db.pragma('page_size') as Array<{ page_size: number }>)[0]?.page_size ?? (db.pragma('page_size') as { page_size: number }).page_size);
    await seed.s.close();
    /** The fill on a copy of that file: the log's largest size on disk while it ran, in pages, and the TRUNCATEs asked of the worker. */
    const fill = async (): Promise<{ maxPages: number; truncates: number }> => {
      const dir = mkdtempSync(join(tmpdir(), 'iris-ckpt-'));
      dirs.push(dir);
      const path = join(dir, 'iris.db');
      copyFileSync(seed.path, path);
      const truncate = vi.spyOn(Checkpointer.prototype, 'truncate');
      const s = new SqliteAdapter(path, { driver: CELL_DRIVER });
      open.push(s);
      let max = 0;
      const sample = setInterval(() => void (max = Math.max(max, size(`${path}-wal`))), 1);
      await s.initialize();
      await s.whenRiskEstimatesStored();
      clearInterval(sample);
      max = Math.max(max, size(`${path}-wal`));
      const truncates = truncate.mock.calls.length;
      truncate.mockRestore();
      return { maxPages: max / pageBytes, truncates };
    };
    const stepped = await fill();
    expect(stepped.truncates).toBeGreaterThan(0);
    // The adapter's own checkpoint runs only once the log holds TAIL_CHECKPOINT_PAGES: the log never got there.
    expect(stepped.maxPages).toBeGreaterThan(STEP_TRUNCATE_PAGES);
    expect(stepped.maxPages).toBeLessThan(TAIL_CHECKPOINT_PAGES);
    // Anti-theater: the same fill with the steps blind to the log's size. Only the adapter's own checkpoint bounds it, inside whichever step takes it past TAIL_CHECKPOINT_PAGES.
    const blind = vi.spyOn(Checkpointer.prototype, 'logBytes').mockReturnValue(0);
    const unstepped = await fill();
    blind.mockRestore();
    expect(unstepped.truncates).toBe(0);
    expect(unstepped.maxPages).toBeGreaterThanOrEqual(TAIL_CHECKPOINT_PAGES);
  }, 90_000);

  it('says whether a TRUNCATE is in flight, and when it is done', async () => {
    const { s } = await store();
    await s.insertTraces(LOCAL_TENANT, traces(10));
    const w = worker(s)!;
    expect(await w.started).toBe(true);
    expect(w.truncateInProgress).toBe(false);
    const run = w.truncate();
    expect(w.truncateInProgress).toBe(true);
    await w.whenTruncated();
    expect(w.truncateInProgress).toBe(false);
    expect(await run).toBe(true);
  });

  it('a database in memory has no worker', async () => {
    const s = new SqliteAdapter(':memory:', { driver: CELL_DRIVER });
    open.push(s);
    await s.initialize();
    expect(worker(s)).toBeUndefined();
  });
});
