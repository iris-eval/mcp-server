/*
 * Fixed-window rate limiting for the public API routes, failing closed.
 *
 * The shared store is Upstash Redis. It used to be the only limit: when
 * Redis was unconfigured or a call to it threw, the route logged the error
 * and served the request with no limit at all, so an outage of the store
 * (or a request crafted to make it error) removed the limit entirely. Now
 * every request that the shared store cannot count is counted by a
 * per-instance window with the same limit. That limit is per server
 * instance rather than global, so it is looser than the shared one, but it
 * is never absent.
 */

/** The subset of the Upstash client this module uses, so tests can pass a stand-in. */
export interface RateLimitStore {
  get<T>(key: string): Promise<T | null>;
  pipeline(): { incr(key: string): unknown; expire(key: string, seconds: number): unknown; exec(): Promise<unknown> };
}

export interface RateLimitDecision {
  limited: boolean;
  /** Requests counted in the current window before this one. */
  count: number;
  /** Which counter decided: the shared store, or this instance's window because the store was absent or failed. */
  source: 'shared' | 'instance';
}

/** A per-instance fixed window, bounded in the number of keys it holds. */
export class InstanceWindow {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one request for `key`; true when it is over the limit. */
  hit(key: string): { limited: boolean; count: number } {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      if (!w && this.windows.size >= this.maxKeys) this.evict(t);
      w = { start: t, count: 0 };
      this.windows.set(key, w);
    }
    if (w.count >= this.max) return { limited: true, count: w.count };
    w.count += 1;
    return { limited: false, count: w.count - 1 };
  }

  private evict(t: number): void {
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
    // Every held window is still live: drop the oldest rather than grow without bound.
    while (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
  }
}

export async function checkRateLimit(opts: {
  store: RateLimitStore | null;
  key: string;
  max: number;
  windowSec: number;
  fallback: InstanceWindow;
  onStoreError?: (err: unknown) => void;
}): Promise<RateLimitDecision> {
  const { store, key, max, windowSec, fallback } = opts;
  if (store) {
    try {
      const count = (await store.get<number>(key)) ?? 0;
      if (count >= max) return { limited: true, count, source: 'shared' };
      const pipeline = store.pipeline();
      pipeline.incr(key);
      pipeline.expire(key, windowSec);
      await pipeline.exec();
      return { limited: false, count, source: 'shared' };
    } catch (err) {
      opts.onStoreError?.(err);
    }
  }
  const { limited, count } = fallback.hit(key);
  return { limited, count, source: 'instance' };
}
