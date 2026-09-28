/*
 * The adapter's side of the search worker (#703).
 *
 * A search's cost grows with the store, and part of it cannot be
 * interrupted once SQLite starts: expanding a prefix into the words it
 * starts, counting the traces each term is in, and on the CJK path scoring
 * every match. Run on the server's thread, that work held every MCP and
 * HTTP request for as long as it took. Run here, on a thread of its own
 * with its own read-only connection (search-worker.ts), it never holds
 * them, whatever the store's size; the adapter's thread only reads the
 * page's rows and builds their snippets, a cost bounded by the page.
 *
 * Lifecycle:
 *   - started on the first search, not at open: a server that never
 *     searches never starts a thread;
 *   - one search at a time, in the order they were asked (the thread has
 *     one connection); the thread is unref'd while idle, so it never keeps
 *     a process alive;
 *   - a thread that fails or exits with searches in flight fails them with
 *     the reason, and the next search starts a new one; a thread that has
 *     not answered within the search's budget plus WORKER_GRACE_MS is
 *     treated as stuck: its searches answer as stopped early with nothing
 *     read (`complete: false`), it is terminated, and the next search
 *     starts a new one;
 *   - close() asks the thread to close its connection itself and waits for
 *     it to end, and terminates it only if it has not ended in
 *     CLOSE_TIMEOUT_MS. It does not wait for that: terminate() cannot stop
 *     a SQLite statement, and resolves only when the statement returns
 *     (measured on Node 24.21 with both better-sqlite3 builds and
 *     node:sqlite: a 6 s statement ended the thread after 6.3 to 6.6 s, and
 *     no terminate aborted the process, mid-statement included). The
 *     thread ends when its statement does.
 */
import { Worker } from 'node:worker_threads';
import type { MatchRequest, MatchResult } from './search-match.js';
import type { SearchWorkerData } from './search-worker.js';

/** How long past its budget a search may go unanswered before its thread is treated as stuck. Covers the thread's start. */
export const WORKER_GRACE_MS = 10_000;
/** How long close() waits for the thread to close its connection and end. */
const CLOSE_TIMEOUT_MS = 5_000;

/** The thread failed before it could search: the caller may search on its own connection instead. */
export class SearchWorkerUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`the search thread could not start: ${reason}`);
  }
}

let warned = false;
/**
 * Say once per process that searches run on the server's thread because
 * the worker could not start, and why: the searches still work, and
 * nothing else would tell an operator they now hold other requests while
 * they run. The health contract and --self-test report the same.
 */
export function warnSearchWorkerUnavailable(reason: string, write: (line: string) => void = (line) => process.stderr.write(`${line}\n`)): void {
  if (warned) return;
  warned = true;
  write(`[iris.storage] The search worker could not start (${reason}); searches run on the main thread, where a slow one holds other requests while it runs.`);
}

/** Tests only: let the next warnSearchWorkerUnavailable write again. */
export function resetSearchWorkerWarning(): void {
  warned = false;
}

interface Pending {
  resolve: (r: MatchResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

export class SearchWorkerClient {
  private worker: Worker | undefined;
  private ready = false;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  /** Threads started, for tests and the health of the pool. */
  started = 0;

  /** `entry` and `closeTimeoutMs`: tests only, a module to run as the thread instead of search-worker's, and how long close() waits. */
  constructor(
    private readonly data: SearchWorkerData,
    private readonly graceMs = WORKER_GRACE_MS,
    private readonly entry?: URL,
    private readonly closeTimeoutMs = CLOSE_TIMEOUT_MS,
  ) {}

  /** Whether a thread is running and has opened its connection. */
  isReady(): boolean {
    return this.worker !== undefined && this.ready;
  }

  /** Match one search on the thread. */
  search(request: MatchRequest): Promise<MatchResult> {
    if (this.closed) return Promise.reject(new Error('the store is closed'));
    const w = this.worker ?? this.start();
    const id = this.nextId++;
    return new Promise<MatchResult>((resolve, reject) => {
      /*
       * No stuck timer for a search with no budget (an export's, which must
       * read every match): it has no deadline to be late for, and setTimeout
       * reads Infinity as 1 ms, which would call every such search stuck.
       */
      const timer = Number.isFinite(request.budgetMs) ? setTimeout(() => this.stuck(w), request.budgetMs + this.graceMs) : undefined;
      timer?.unref();
      this.pending.set(id, { resolve, reject, timer });
      w.ref();
      w.postMessage({ id, request });
    });
  }

  private start(): Worker {
    /*
     * The built package runs search-worker.js beside this file. From the
     * TypeScript sources (tests, `npx tsx`), the thread needs tsx's loader
     * to read search-worker.ts and the imports it spells with .js.
     */
    const source = import.meta.url.endsWith('.ts');
    const entry = new URL(source ? './search-worker.ts' : './search-worker.js', import.meta.url);
    // A thread does not take --import, so from the sources it registers tsx's loader itself, then loads the entry.
    let w: Worker;
    if (this.entry) w = new Worker(this.entry, { workerData: this.data });
    else if (source) w = new Worker(`import('tsx/esm/api').then((tsx) => { tsx.register(); return import(${JSON.stringify(entry.href)}); })`, { eval: true, workerData: this.data });
    else w = new Worker(entry, { workerData: this.data });
    this.worker = w;
    this.ready = false;
    this.started += 1;
    w.unref();
    w.on('message', (msg: { type?: 'ready'; id?: number; result?: MatchResult; error?: { message: string } }) => {
      if (msg.type === 'ready') {
        this.ready = true;
        return;
      }
      const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      this.settle(msg.id!);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result!);
      if (this.pending.size === 0 && this.worker === w) w.unref();
    });
    w.on('error', (err: unknown) => this.lost(w, err instanceof Error ? err.message : String(err)));
    w.on('exit', (code) => this.lost(w, `the search thread exited with code ${code}`));
    return w;
  }

  private settle(id: number): void {
    const p = this.pending.get(id);
    if (p) clearTimeout(p.timer);
    this.pending.delete(id);
  }

  /** The thread ended or failed: fail what it was running, and let the next search start another. */
  private lost(w: Worker, reason: string): void {
    if (this.worker !== w) return;
    const beforeReady = !this.ready;
    this.worker = undefined;
    for (const [id, p] of [...this.pending]) {
      this.settle(id);
      p.reject(beforeReady ? new SearchWorkerUnavailable(reason) : new Error(`the search thread stopped: ${reason}`));
    }
  }

  /** No answer in the budget plus the grace: answer every search on this thread as stopped with nothing read, and replace it. */
  private stuck(w: Worker): void {
    if (this.worker !== w) return;
    this.worker = undefined;
    for (const [id, p] of [...this.pending]) {
      this.settle(id);
      p.resolve({ total: 0, pageIds: [], matches: [], complete: false });
    }
    // The statement it is in runs to its end in C; the thread ends then.
    void w.terminate();
  }

  async close(): Promise<void> {
    this.closed = true;
    const w = this.worker;
    this.worker = undefined;
    for (const [id, p] of [...this.pending]) {
      this.settle(id);
      p.reject(new Error('the store is closed'));
    }
    if (!w) return;
    const exited = new Promise<void>((resolve) => w.once('exit', () => resolve()));
    w.postMessage({ type: 'close' });
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), this.closeTimeoutMs);
    });
    if ((await Promise.race([exited, late])) === 'late') void w.terminate();
    clearTimeout(timer);
  }
}
