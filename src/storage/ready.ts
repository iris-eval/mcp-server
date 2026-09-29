/*
 * The store's readiness, for a server that answers before its upgrade is
 * done (sqlite-adapter.ts, upgradeAfterStart).
 *
 * On a file with migrations pending the server connects first, and the
 * copy taken before migrating and the migrations run after, on the
 * checkpoint worker's connection. Until they are done nothing may read or
 * write the store: its tables are the old release's. One gate holds every
 * door to it:
 *
 *   - a request (an MCP tool call or resource read, an HTTP API or OTLP
 *     request) waits at `wait()`, at most STORE_READY_WAIT_MS, and is then
 *     refused with a sentence that says what the store is doing, so a
 *     client is never left hanging on a file that will not finish;
 *   - the server's own work (the retention sweep, the webhook, anything
 *     else holding the store) reaches it through `storage`, whose methods
 *     wait for `ready` without a bound, because nobody is waiting on them;
 *   - `hold` adds what the server must read before it answers anything
 *     (the deployment's verdict labels), so no request is let through to
 *     an engine that has not read them.
 *
 * A store that has nothing to upgrade is ready when initialize() returns,
 * and every wait resolves in the same turn.
 */
import type { IStorageAdapter } from '../types/query.js';
import type { StoreReadiness } from './sqlite-adapter.js';

/**
 * How long a request waits for an upgrade before it is refused. From
 * 0.19.0 at 100,000 agent-loop traces the copy took 3.5 s and the
 * migrations 1.7 s on the machine in the changelog: a request waits out an
 * upgrade of that size several times over, and is refused with a reason
 * rather than left to hang when one takes longer than a client should wait
 * for one answer.
 */
export const STORE_READY_WAIT_MS = 30_000;

/** A request that arrived while the store was being upgraded and waited as long as it may. */
export class StoreNotReadyError extends Error {
  readonly status = 503;
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'StoreNotReadyError';
    this.retryable = retryable;
  }
}

/** What the store is doing, in the words a refused request carries. */
export function describeReadiness(r: StoreReadiness | undefined): string {
  switch (r?.state) {
    case 'copying':
      return 'copying its database before migrating it';
    case 'migrating':
      return 'applying its database migrations';
    default:
      return 'opening its database';
  }
}

export interface StoreGate {
  /** The store, its methods waiting for the store to serve (never refused: the server's own work waits as long as it takes). */
  storage: IStorageAdapter;
  /** Resolves once the store serves and everything held has settled; rejects when either failed. */
  readonly ready: Promise<void>;
  /** Keep requests out until `work` has settled too: what the server reads from the store before it answers anything. */
  hold(work: Promise<unknown>): void;
  /** For a request: resolves when ready, or throws StoreNotReadyError after `waitMs` or when getting ready failed. */
  wait(): Promise<void>;
  /** Whether a request would pass without waiting. */
  readonly open: boolean;
}

/** Methods that answer while the store is upgraded: health's checks and the store's own lifecycle. */
const PASS_THROUGH = new Set<string>(['initialize', 'close', 'whenReady', 'readiness', 'upgradeReport', 'migrations', 'searchStatus', 'searchWorkerStatus', 'judgeSpendLedger', 'onEvalResultInserted']);

export function storeGate(raw: IStorageAdapter, options: { waitMs?: number } = {}): StoreGate {
  const waitMs = options.waitMs ?? STORE_READY_WAIT_MS;
  const storeReady = raw.whenReady?.() ?? Promise.resolve();
  let storeOpen = false;
  storeReady.then(
    () => (storeOpen = true),
    () => undefined,
  );
  const held: Array<Promise<unknown>> = [];
  let ready: Promise<void> = storeReady;
  let open = false;
  let failure: Error | undefined;
  const settle = () => {
    const current = Promise.all([storeReady, ...held]).then(() => undefined);
    ready = current;
    open = false;
    current.then(
      () => {
        if (ready === current) open = true;
      },
      (err: unknown) => {
        if (ready === current) failure = err instanceof Error ? err : new Error(String(err));
      },
    );
  };
  settle();

  const storage = new Proxy(raw, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      const fn = (value as (...a: unknown[]) => unknown).bind(target);
      if (typeof prop !== 'string' || PASS_THROUGH.has(prop)) return fn;
      // An export streams batches (an async generator): the stream waits before its first batch.
      if ((value as { constructor?: { name?: string } }).constructor?.name === 'AsyncGeneratorFunction') {
        return async function* (...args: unknown[]) {
          if (!storeOpen) await storeReady;
          yield* fn(...args) as AsyncGenerator<unknown>;
        };
      }
      // Every other method of IStorageAdapter returns a promise: waiting first keeps its shape.
      return async (...args: unknown[]) => {
        if (!storeOpen) await storeReady;
        return fn(...args);
      };
    },
  });

  const wait = async (): Promise<void> => {
    if (open) return;
    if (failure) throw refusedAfterFailure(failure);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), waitMs);
      timer.unref();
    });
    try {
      if ((await Promise.race([ready.then(() => 'ready' as const), late])) === 'late') {
        throw new StoreNotReadyError(
          `Iris is still ${describeReadiness(raw.readiness?.())} after an upgrade, and this request waited ${Math.round(waitMs / 1000)} s for it. Try again shortly: requests are answered as soon as it is done.`,
          true,
        );
      }
    } catch (err) {
      if (err instanceof StoreNotReadyError) throw err;
      throw refusedAfterFailure(err instanceof Error ? err : new Error(String(err)));
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    storage,
    get ready() {
      return ready;
    },
    hold(work) {
      held.push(work);
      settle();
    },
    wait,
    get open() {
      return open;
    },
  };
}

function refusedAfterFailure(err: Error): StoreNotReadyError {
  return new StoreNotReadyError(`Iris could not get its database ready, so it cannot read or store anything: ${err.message}`, false);
}
