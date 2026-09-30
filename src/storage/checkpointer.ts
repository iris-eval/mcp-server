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
 * So the copying moves to a worker thread (checkpoint-worker.ts), which
 * holds a second connection to the same file and runs a PASSIVE checkpoint
 * CHECKPOINT_INTERVAL_MS after the last one ended: it copies what it can
 * and never waits on a writer. What stays on the adapter's connection is SQLite's own
 * checkpoint, at TAIL_CHECKPOINT_PAGES instead of 1,000. By then the
 * worker has copied all but the last CHECKPOINT_INTERVAL_MS of writes, so
 * that checkpoint copies only those, and it is what lets the log start
 * over: SQLite restarts the log at a write that finds every frame copied,
 * which a copy on another connection never guarantees while writes keep
 * coming. With the worker alone (#727), the log grew with every write,
 * and every read and write on the adapter's connection paid for looking
 * through it: 1,000 log_trace calls over stdio at 100,000 agent-loop
 * traces left a 153 MB log and took 1.28 to 1.46 ms at the median; with
 * the tail checkpoint the log stays about 64 MB and they take 1.05 to 1.26
 * ms, the slowest 1% 22 to 24 ms (0.19.0: 0.67 to 0.77 ms, a 4 MB log).
 *
 * Background steps that rewrite many rows (the index build, the risk
 * fill) fill the log faster than the worker copies it, so the tail
 * checkpoint would land in a step's commit, and hold the event loop with
 * it, in every few steps. Before each step the adapter has the worker
 * TRUNCATE the log once it holds STEP_TRUNCATE_PAGES, and waits for that
 * off the event loop. The index build after an upgrade at 100,000
 * agent-loop traces left a 2.6 GB log with the worker alone, its longest
 * hold 193 to 195 ms; now 10 to 22 MB, 62 to 72 ms, and 66 to 69 s
 * instead of 64 s. The worker also runs TRUNCATE when the adapter asks
 * after delete_trace, a retention sweep or a purge, so the WAL keeps no
 * copy of what was deleted, answering when it is done or that a reader
 * held it off, in which case the adapter tries again while the reader
 * reads. A TRUNCATE holds the write lock while it runs: a request that
 * writes meanwhile waits for it.
 *
 * Until the worker says it is ready, and again if it ever fails, the
 * adapter's connection checkpoints by itself as before (the default 1,000
 * pages), so the file never goes without. A database in memory has no WAL
 * and no worker.
 *
 * Lifecycle, the search worker's (search-worker-client.ts): started on the
 * store's first write, not at open, so a store that is only read never
 * starts a thread; unref'd while idle; a thread that stops after it was
 * ready is replaced on the next write, and one that could not start is not
 * tried again by that store; close() asks the thread to close its
 * connection itself and waits for it to end, terminates it if it has not
 * ended in CLOSE_TIMEOUT_MS, and resolves only once the thread has ended.
 */
import { statSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import type { DriverName } from './driver.js';
import type { CheckpointWorkerData } from './checkpoint-worker.js';

/** How long after one copy of the log into the file the worker starts the next. */
export const CHECKPOINT_INTERVAL_MS = 250;
/** What the adapter's own connection falls back to: SQLite's default. */
export const AUTOCHECKPOINT_PAGES = 1000;
/**
 * The adapter's own checkpoint threshold while the worker runs (64 MB at
 * 4 KB pages): a checkpoint that copies only what the worker has not, and
 * starts the log over. At 4,000 pages the log_trace median was the same
 * and the index build paid a TRUNCATE twice as often: 73 s instead of 66
 * to 69 s.
 */
export const TAIL_CHECKPOINT_PAGES = 16_000;
/**
 * A background write step (sqlite-adapter.ts, beforeWriteStep) has the
 * worker TRUNCATE the log once it holds this many pages, and waits for it
 * off the event loop: below TAIL_CHECKPOINT_PAGES, so the adapter's own
 * checkpoint does not land in a step.
 */
export const STEP_TRUNCATE_PAGES = 8_000;
/** How long close() waits for the thread to close its connection and end. */
const CLOSE_TIMEOUT_MS = 5_000;

export interface CheckpointerOptions {
  path: string;
  driver: DriverName;
  busyMs: number;
  /** Called once the worker checkpoints: the adapter's connection keeps only the tail checkpoint (TAIL_CHECKPOINT_PAGES). */
  onReady: () => void;
  /** Called if the worker fails or stops: the adapter's connection checkpoints by itself again. */
  onFailed: (reason: string) => void;
  /** How long close() lets the thread end on its own before it terminates it (CLOSE_TIMEOUT_MS); for tests. */
  closeTimeoutMs?: number;
}

export class Checkpointer {
  private readonly worker: Worker;
  private ready = false;
  private failed = false;
  private nextId = 1;
  private readonly waiting = new Map<number, (reply: { busy?: number; error?: string }) => void>();
  /** A TRUNCATE in flight: it holds the write lock, so a write step started meanwhile would wait for it on the event loop. */
  private truncating: Promise<boolean> | undefined;
  private settle: (active: boolean) => void = () => undefined;
  /** Resolves true once the worker checkpoints, false if it failed first. */
  readonly started: Promise<boolean> = new Promise((resolve) => (this.settle = resolve));
  private readonly exited: Promise<void>;

  constructor(private readonly options: CheckpointerOptions) {
    const data: CheckpointWorkerData = {
      path: options.path,
      // The driver the adapter's connection got, never the one it asked for: openDriver in the thread runs the same checks (#720).
      driver: options.driver === 'node' ? 'node' : 'native',
      busyMs: options.busyMs,
      intervalMs: CHECKPOINT_INTERVAL_MS,
    };
    /*
     * The built package runs checkpoint-worker.js beside this file. From the
     * TypeScript sources (tests, `npx tsx`), the thread registers tsx's
     * loader itself, as the search worker does (search-worker-client.ts).
     */
    const source = import.meta.url.endsWith('.ts');
    const entry = new URL(source ? './checkpoint-worker.ts' : './checkpoint-worker.js', import.meta.url);
    this.worker = source
      ? new Worker(`import('tsx/esm/api').then((tsx) => { tsx.register(); return import(${JSON.stringify(entry.href)}); })`, { eval: true, workerData: data })
      : new Worker(entry, { workerData: data });
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
    this.exited = new Promise((resolve) => this.worker.once('exit', () => resolve()));
    this.worker.on('exit', (code) => {
      if (!this.failed) this.fail(`the checkpoint worker exited (code ${code})`);
    });
    // Never the reason a process stays alive: a server whose client has gone, or a CLI that is done, exits. After the listeners, which would hold it again.
    this.worker.unref();
  }

  /**
   * `started`, for a caller that goes on only once the thread is up: the
   * thread is held while it starts, so a CLI with nothing else to do does
   * not exit under a promise that can never settle.
   */
  async whenStarted(): Promise<boolean> {
    this.worker.ref();
    try {
      return await this.started;
    } finally {
      if (this.waiting.size === 0) this.worker.unref();
    }
  }

  /** Whether the worker is checkpointing: false before it is ready and after it failed. */
  get active(): boolean {
    return this.ready && !this.failed;
  }

  /** Whether it has stopped, and whether it had been ready first (a crash, worth a new thread) or never was (it cannot start here). */
  get stopped(): 'no' | 'after-ready' | 'before-ready' {
    return !this.failed ? 'no' : this.ready ? 'after-ready' : 'before-ready';
  }

  private fail(reason: string): void {
    if (this.failed) return;
    this.failed = true;
    for (const reply of this.waiting.values()) reply({ error: reason });
    this.waiting.clear();
    this.options.onFailed(reason);
    this.settle(false);
  }

  private request(message: { type: 'checkpoint'; mode: 'PASSIVE' | 'TRUNCATE' } | { type: 'exec'; sql: string } | { type: 'close' }): Promise<{ busy?: number; error?: string }> {
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
    const run = (async () => {
      const reply = await this.request({ type: 'checkpoint', mode: 'TRUNCATE' });
      if (reply.error) throw new Error(reply.error);
      return !reply.busy;
    })();
    this.truncating = run;
    try {
      return await run;
    } finally {
      if (this.truncating === run) this.truncating = undefined;
    }
  }

  /**
   * The log's size on disk. A TRUNCATE empties the file, so after one this
   * is the log itself; a restart by the adapter's own checkpoint reuses the
   * file without shrinking it, so it can read high until the next TRUNCATE.
   */
  logBytes(): number {
    try {
      return statSync(`${this.options.path}-wal`).size;
    } catch {
      return 0;
    }
  }

  /** Whether a TRUNCATE is in flight on the worker's connection. */
  get truncateInProgress(): boolean {
    return this.truncating !== undefined;
  }

  /** Resolves when no TRUNCATE is in flight: a write step waits for it here rather than on the lock. */
  async whenTruncated(): Promise<void> {
    while (this.truncating) await this.truncating.catch(() => undefined);
  }

  /**
   * Run one statement on the worker's connection, off the event loop: the
   * covering index created after the start (sqlite-adapter.ts). It holds the
   * write lock while it runs, so the adapter starts no write step of its own
   * until it is done. Throws with SQLite's message when it failed.
   */
  async exec(sql: string): Promise<void> {
    const reply = await this.request({ type: 'exec', sql });
    if (reply.error) throw new Error(reply.error);
  }

  /**
   * Ask the thread to close its connection, and wait for it to end on its
   * own; terminate it if it has not in CLOSE_TIMEOUT_MS (terminate cannot
   * stop a SQLite statement; the thread ends when its statement does), and
   * resolve once it has ended.
   */
  async close(): Promise<void> {
    this.settle(false);
    if (this.failed) return;
    this.failed = true;
    this.worker.ref();
    this.worker.postMessage({ type: 'close', id: this.nextId++ });
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), this.options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS);
    });
    /*
     * Resolves only once the thread has ended, and its connection with it,
     * so a caller can move or remove the file as soon as this returns (on
     * Windows an open file cannot be). A statement the thread is in cannot
     * be stopped: the close message waits behind it, and terminate() ends the
     * thread when it returns. This used to return at the timeout with the
     * thread still in its statement and the file still open.
     */
    if ((await Promise.race([this.exited, late])) === 'late') await this.worker.terminate();
    clearTimeout(timer);
    await this.exited;
    // A request the thread never answered (it was terminated in it, or it came after the close) is answered now, so nothing waits on it forever.
    for (const reply of this.waiting.values()) reply({ error: 'the checkpoint worker closed' });
    this.waiting.clear();
  }
}
