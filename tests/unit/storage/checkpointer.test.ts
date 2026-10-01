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
import { closeSync, copyFileSync, mkdtempSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter, type SqliteAdapterOptions } from '../../../src/storage/sqlite-adapter.js';
import { Checkpointer, STEP_TRUNCATE_PAGES, TAIL_CHECKPOINT_PAGES } from '../../../src/storage/checkpointer.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import type { Driver } from '../../../src/storage/driver.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import { CELL_DRIVER, driverHasFts5 } from './fts5-here.js';

/*
 * The hooks get the tests' time: afterEach closes each store, and close()
 * now waits for the worker's statement in progress (#750), which after the
 * heavier cases here ran past the 10 s default on a windows-latest runner.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const dirs: string[] = [];
const open: SqliteAdapter[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

type Log = Array<['info' | 'warn', string]>;

async function store(log: Log = [], options: SqliteAdapterOptions = {}): Promise<{ s: SqliteAdapter; path: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'iris-ckpt-'));
  dirs.push(dir);
  const path = join(dir, 'iris.db');
  const s = new SqliteAdapter(path, { driver: CELL_DRIVER, log: (level, line) => void log.push([level, line]), ...options });
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

  it('a search index step never starts while the worker truncates the log, which holds the write lock', async () => {
    const { s } = await store();
    await s.insertTraces(LOCAL_TENANT, traces(200));
    const w = worker(s)!;
    expect(await w.started).toBe(true);
    await s.whenSearchIndexReady();
    // Queued for the index (a write of fewer than 100 traces), then a TRUNCATE asked for before the indexer takes it.
    await s.insertTraces(LOCAL_TENANT, traces(5, 1000));
    const order: string[] = [];
    const db = dbOf(s) as unknown as { transaction: (fn: (...a: unknown[]) => unknown) => { immediate: (...a: unknown[]) => unknown } };
    const transaction = db.transaction.bind(db);
    db.transaction = (fn) => {
      const t = transaction(fn);
      return Object.assign((...a: unknown[]) => (t as unknown as (...a: unknown[]) => unknown)(...a), {
        immediate: (...a: unknown[]) => {
          order.push('step');
          return t.immediate(...a);
        },
      });
    };
    const truncated = w.truncate().then(() => order.push('truncated'));
    expect(w.truncateInProgress).toBe(true);
    await s.whenSearchIndexReady();
    await truncated;
    expect(w.truncateInProgress).toBe(false);
    expect(order[0]).toBe('truncated');
    if (driverHasFts5(CELL_DRIVER)) expect(order).toContain('step');
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

  /*
   * A statement the thread is in when close() is asked cannot be stopped:
   * the close message waits behind it, and terminate() only ends the thread
   * when the statement returns. close() used to return at its timeout with
   * the thread, and so the file, still open; on Windows the file could then
   * not be removed (EPERM). It now resolves only once the thread has ended,
   * and answers the request the thread was in.
   */
  it('close() resolves only once the thread has ended, even when it is in a statement past the timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-ckpt-'));
    dirs.push(dir);
    const path = join(dir, 'iris.db');
    const seed = new SqliteAdapter(path, { driver: CELL_DRIVER });
    await seed.initialize();
    await seed.insertTraces(LOCAL_TENANT, traces(1));
    await seed.close();
    const w = new Checkpointer({ path, driver: CELL_DRIVER === 'node' ? 'node' : 'better-sqlite3', busyMs: 5000, onReady: () => undefined, onFailed: () => undefined, closeTimeoutMs: 100 });
    expect(await w.started).toBe(true);
    const thread = (w as unknown as { worker: { once(e: 'exit', f: (code: number) => void): void } }).worker;
    let ended = false;
    thread.once('exit', () => (ended = true));
    // A statement that runs well past the 100 ms timeout on any machine.
    const slow = w.exec('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 20000000) SELECT count(*) FROM c').then(
      () => 'answered',
      (err: Error) => err.message,
    );
    await new Promise((r) => setTimeout(r, 50));
    const began = performance.now();
    await w.close();
    const waited = performance.now() - began;
    expect(ended).toBe(true);
    // It waited for the statement, past its timeout, rather than returning at it.
    expect(waited).toBeGreaterThan(100);
    // The request the thread was in is answered, never left waiting (it used to be, once close() had begun).
    expect(await slow).toMatch(/answered|the checkpoint worker closed/);
  });

  it('holds the thread from close() on, even when the answer to a request in flight empties its queue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-ckpt-'));
    dirs.push(dir);
    const path = join(dir, 'iris.db');
    const seed = new SqliteAdapter(path, { driver: CELL_DRIVER });
    await seed.initialize();
    await seed.insertTraces(LOCAL_TENANT, traces(1));
    await seed.close();
    const w = new Checkpointer({ path, driver: CELL_DRIVER === 'node' ? 'node' : 'better-sqlite3', busyMs: 5000, onReady: () => undefined, onFailed: () => undefined });
    expect(await w.started).toBe(true);
    const thread = (w as unknown as { worker: { unref(): void } }).worker;
    const truncated = w.truncate().catch(() => false);
    const unref = vi.spyOn(thread, 'unref');
    await w.close();
    await truncated;
    // An unref once close() has begun would let a CLI's event loop empty while close() still waits for the
    // thread, and Node would exit 13 with the close unsettled (seen in the worker-exit job, 1 process in 10).
    expect(unref).not.toHaveBeenCalled();
  });

  it('lets the log start over under writes that never pause', async () => {
    /** The write-ahead log header's checkpoint sequence number: SQLite adds one each time the log starts over. */
    const restarts = (path: string): number => {
      const fd = openSync(`${path}-wal`, 'r');
      try {
        const header = Buffer.alloc(16);
        readSync(fd, header, 0, 16, 0);
        return header.readUInt32BE(12);
      } finally {
        closeSync(fd);
      }
    };
    /** One trace per write, back to back, as a client that never pauses sends them. */
    const write = async (s: SqliteAdapter, i: number) => {
      await s.insertTrace(LOCAL_TENANT, traces(1, 1_000_000 + i)[0]);
      await new Promise((r) => setImmediate(r));
    };
    // The tail checkpoint at a fifth of its size (checkpointPages), so the writes that take the log to twice it are a fifth as many (#756).
    const PAGES = { tail: TAIL_CHECKPOINT_PAGES / 5, stepTruncate: STEP_TRUNCATE_PAGES / 5 };
    const tailBytes = PAGES.tail * 4096;
    // Anti-theater, and the yardstick: with nothing checkpointing, the writes that take the log to twice the tail threshold never start it over.
    const idle = await store();
    (idle.s as unknown as { ensureCheckpointer: () => void }).ensureCheckpointer = () => undefined;
    dbOf(idle.s).pragma('wal_autocheckpoint = 0');
    await write(idle.s, 0);
    const before = restarts(idle.path);
    let n = 1;
    while (size(`${idle.path}-wal`) < 2 * tailBytes) await write(idle.s, n++);
    expect(restarts(idle.path)).toBe(before);
    // With the worker and the tail checkpoint, writes like those start the log over: the log restarts only at a write that finds every frame copied, which the worker's copy alone never guarantees while writes keep coming.
    const tail = await store([], { checkpointPages: PAGES });
    await write(tail.s, 0);
    expect(await worker(tail.s)!.started).toBe(true);
    const first = restarts(tail.path);
    let i = 1;
    for (; i < n; i += 1) await write(tail.s, i);
    // On a slow disk one copy by the worker can outlast those writes, holding the checkpoint lock throughout: the writes go on until it lets go, for at most 30 s.
    const deadline = Date.now() + 30_000;
    while (restarts(tail.path) === first && Date.now() < deadline) await write(tail.s, i++);
    const seen = { writes: i, restarts: restarts(tail.path) - first, logMb: size(`${tail.path}-wal`) / 2 ** 20, uncheckedMb: size(`${idle.path}-wal`) / 2 ** 20, autocheckpoint: autocheckpoint(tail.s), worker: worker(tail.s)?.active };
    expect(seen.restarts, JSON.stringify(seen)).toBeGreaterThan(0);
  }, 90_000);

  it('has the worker empty the log before a background step that finds it past STEP_TRUNCATE_PAGES, so the adapter’s own checkpoint stays out of the steps', async () => {
    /*
     * 2,500 evaluations with no stored risk estimate, as 0.19.0 left them (a
     * fill starts the worker from RISK_FILL_WORKER_ROWS, 2,048), and both
     * thresholds a fifth of their size (checkpointPages): the fill after the
     * start rewrites every row, more log than the tail checkpoint's (the
     * anti-theater half shows it). At full size, 8,000 evaluations, this took
     * 18 to 50 s on a Windows runner and at times more than 90 s (#756); the
     * stall suite measures the log at full size.
     * It runs the fill twice. At this size the pair takes about 3 s on a
     * desktop and took 6.8 s to more than 30 s on the hosted Windows runner (node
     * driver, Node 24), so it has 90 s rather than the file's 30.
     */
    const PAGES = { tail: TAIL_CHECKPOINT_PAGES / 5, stepTruncate: STEP_TRUNCATE_PAGES / 5 };
    const seed = await store();
    const result = await new EvalEngine().evaluateAll({ output: 'The order shipped on Monday and should arrive by Thursday.', input: 'Where is my order?' });
    await seed.s.insertEvalResult(LOCAL_TENANT, { ...result, id: 'e-0', trace_id: undefined });
    const db = dbOf(seed.s);
    const cols = (db.prepare("SELECT name FROM pragma_table_info('eval_results') WHERE name <> 'id'").all() as Array<{ name: string }>).map((c) => c.name).join(', ');
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2499) INSERT INTO eval_results (id, ${cols}) SELECT 'e-' || i, ${cols} FROM n, (SELECT * FROM eval_results WHERE id = 'e-0')`);
    db.exec('UPDATE eval_results SET risk_estimate = NULL, risk_version = NULL');
    const pageBytes = Number((db.pragma('page_size') as Array<{ page_size: number }>)[0]?.page_size ?? (db.pragma('page_size') as { page_size: number }).page_size);
    // Everything in iris.db itself before it is copied: the copy below takes that file alone.
    await seed.s.checkpoint();
    await seed.s.close();
    expect(size(`${seed.path}-wal`)).toBe(0);
    /** The fill on a copy of that file: the log's largest size on disk while it ran, in pages, and the TRUNCATEs asked of the worker. */
    const fill = async (): Promise<{ maxPages: number; truncates: number }> => {
      const dir = mkdtempSync(join(tmpdir(), 'iris-ckpt-'));
      dirs.push(dir);
      const path = join(dir, 'iris.db');
      copyFileSync(seed.path, path);
      const truncate = vi.spyOn(Checkpointer.prototype, 'truncate');
      const s = new SqliteAdapter(path, { driver: CELL_DRIVER, checkpointPages: PAGES });
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
    expect(stepped.maxPages).toBeGreaterThan(PAGES.stepTruncate);
    expect(stepped.maxPages).toBeLessThan(PAGES.tail);
    // Anti-theater: the same fill with the steps blind to the log's size. Only the adapter's own checkpoint bounds it, inside whichever step takes it past TAIL_CHECKPOINT_PAGES.
    const blind = vi.spyOn(Checkpointer.prototype, 'logBytes').mockReturnValue(0);
    const unstepped = await fill();
    blind.mockRestore();
    expect(unstepped.truncates).toBe(0);
    expect(unstepped.maxPages).toBeGreaterThanOrEqual(PAGES.tail);
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
