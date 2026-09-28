/*
 * WAL checkpoints, off the event loop.
 *
 * In WAL mode every commit appends to iris.db-wal, and a checkpoint copies
 * those pages back into iris.db and syncs it. SQLite runs one by itself
 * inside whichever commit takes the log past 1,000 pages, on the
 * connection that commits: here, the event loop. On a large file that
 * commit is the slow one. Measured at 100,000 agent-loop traces (a 1 GB
 * file) on the machine in the changelog, the retention sweep's steps
 * committed in 3 ms at the median and up to 567 ms when a checkpoint
 * landed in them; with the automatic checkpoint off, the slowest commit
 * took 20 ms. Every write paid it, log_trace included; background steps
 * sized to 50 ms could not.
 *
 * So the adapter's connection does not checkpoint by itself. This worker
 * thread holds a second connection to the same file and checkpoints from
 * there: PASSIVE every CHECKPOINT_INTERVAL_MS, which copies what it can
 * and never waits on a writer, and TRUNCATE when the adapter asks (after
 * delete_trace, a retention sweep or a purge, so the WAL keeps no copy of
 * what was deleted), answering when it is done or that a reader held it
 * off, in which case the adapter tries again while the reader reads.
 * Writers go on while it runs: WAL lets one connection append while
 * another checkpoints.
 *
 * Until the worker says it is ready, and again if it ever fails, the
 * adapter's connection checkpoints by itself as before (the default 1,000
 * pages), so the file never goes without. A database in memory has no WAL
 * and no worker.
 */
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import type { DriverName } from './driver.js';

/** How often the worker copies the log into the file. */
export const CHECKPOINT_INTERVAL_MS = 250;
/** What the adapter's own connection falls back to: SQLite's default. */
export const AUTOCHECKPOINT_PAGES = 1000;

/*
 * The worker's code, run as a CommonJS script. It opens the file with the
 * driver the adapter chose (better-sqlite3 by its resolved path, or
 * node:sqlite), and answers { id, busy?, error? } to each request.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { path, driver, modulePath, busyMs, intervalMs } = workerData;
let db;
let pragma;
if (driver === 'better-sqlite3') {
  const Database = require(modulePath);
  db = new Database(path, { timeout: busyMs, fileMustExist: true });
  pragma = (text) => db.pragma(text);
} else {
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(path, { allowExtension: false });
  db.exec('PRAGMA busy_timeout = ' + busyMs);
  pragma = (text) => db.prepare('PRAGMA ' + text).get();
}
const run = (mode) => {
  // A TRUNCATE never waits for a reader: it answers busy, and the adapter tries again while the reader reads.
  if (mode === 'TRUNCATE') pragma('busy_timeout = 0');
  try {
    const out = pragma('wal_checkpoint(' + mode + ')');
    const row = Array.isArray(out) ? out[0] : out;
    // busy: a reader held the log past the busy timeout, so not all of it was copied (and a TRUNCATE did not empty it).
    return { busy: row ? Number(row.busy) : 0 };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  } finally {
    if (mode === 'TRUNCATE') pragma('busy_timeout = ' + busyMs);
  }
};
const timer = setInterval(() => run('PASSIVE'), intervalMs);
parentPort.on('message', (m) => {
  if (m.type === 'checkpoint') parentPort.postMessage({ id: m.id, ...run(m.mode) });
  else if (m.type === 'close') {
    clearInterval(timer);
    db.close();
    parentPort.postMessage({ id: m.id });
    parentPort.close();
  }
});
parentPort.postMessage({ ready: true });
`;

export interface CheckpointerOptions {
  path: string;
  driver: DriverName;
  busyMs: number;
  /** Called once the worker checkpoints: the adapter's connection stops checkpointing by itself. */
  onReady: () => void;
  /** Called if the worker fails or stops: the adapter's connection checkpoints by itself again. */
  onFailed: (reason: string) => void;
}

export class Checkpointer {
  private readonly worker: Worker;
  private ready = false;
  private failed = false;
  private nextId = 1;
  private readonly waiting = new Map<number, (reply: { busy?: number; error?: string }) => void>();
  private settle: (active: boolean) => void = () => undefined;
  /** Resolves true once the worker checkpoints, false if it failed first. */
  readonly started: Promise<boolean> = new Promise((resolve) => (this.settle = resolve));

  constructor(private readonly options: CheckpointerOptions) {
    const require = createRequire(import.meta.url);
    const modulePath = options.driver === 'better-sqlite3' ? require.resolve('better-sqlite3') : null;
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { path: options.path, driver: options.driver, modulePath, busyMs: options.busyMs, intervalMs: CHECKPOINT_INTERVAL_MS },
    });
    this.worker.on('message', (m: { ready?: boolean; id?: number; busy?: number; error?: string }) => {
      if (m.ready) {
        this.ready = true;
        options.onReady();
        this.settle(true);
        return;
      }
      if (m.id !== undefined) {
        this.waiting.get(m.id)?.(m);
        this.waiting.delete(m.id);
        if (this.waiting.size === 0) this.worker.unref();
      }
    });
    this.worker.on('error', (err) => this.fail(err instanceof Error ? err.message : String(err)));
    this.worker.on('exit', (code) => {
      if (!this.failed) this.fail(`the checkpoint worker exited (code ${code})`);
    });
    // Never the reason a process stays alive: a server whose client has gone, or a CLI that is done, exits. After the listeners, which would hold it again.
    this.worker.unref();
  }

  /** Whether the worker is checkpointing: false before it is ready and after it failed. */
  get active(): boolean {
    return this.ready && !this.failed;
  }

  private fail(reason: string): void {
    if (this.failed) return;
    this.failed = true;
    for (const reply of this.waiting.values()) reply({ error: reason });
    this.waiting.clear();
    this.options.onFailed(reason);
    this.settle(false);
  }

  private request(message: { type: 'checkpoint'; mode: 'PASSIVE' | 'TRUNCATE' } | { type: 'close' }): Promise<{ busy?: number; error?: string }> {
    if (this.failed) return Promise.resolve({ error: 'the checkpoint worker is not running' });
    const id = this.nextId++;
    // Held while a request is in flight: a CLI awaiting its checkpoint must not exit before the answer.
    this.worker.ref();
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.worker.postMessage({ ...message, id });
    });
  }

  /**
   * A TRUNCATE checkpoint on the worker's connection, which gives up at once
   * rather than wait for a reader (a search reading the file, say: a delete
   * must not wait for it). Resolves true when the log was copied and
   * emptied, false when a reader held it off; throws when the worker failed.
   */
  async truncate(): Promise<boolean> {
    const reply = await this.request({ type: 'checkpoint', mode: 'TRUNCATE' });
    if (reply.error) throw new Error(reply.error);
    return !reply.busy;
  }

  /** Close the worker's connection and stop it. */
  async close(): Promise<void> {
    this.settle(false);
    if (!this.failed) {
      this.failed = true;
      const id = this.nextId++;
      this.worker.ref();
      const closed = new Promise<void>((resolve) => {
        this.waiting.set(id, () => resolve());
        this.worker.postMessage({ type: 'close', id });
      });
      // A worker that does not answer within a second is stopped anyway.
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000).unref())]);
    }
    await this.worker.terminate();
  }
}
