/*
 * The playground's rate limit never disappears.
 *
 * /api/playground/eval counted requests in Upstash Redis and, when that
 * store was unconfigured or a call to it threw, served the request with no
 * limit at all. website/src/lib/rate-limit.ts now falls back to a
 * per-instance window with the same limit. These tests drive it with a
 * store that fails, a store that works, and no store.
 */
import { describe, expect, it } from 'vitest';
import { checkRateLimit, InstanceWindow, type RateLimitStore } from '../website/src/lib/rate-limit.js';

const MAX = 3;

function failingStore(): RateLimitStore {
  return {
    get: async () => {
      throw new Error('store unreachable');
    },
    pipeline: () => ({ incr: () => undefined, expire: () => undefined, exec: async () => undefined }),
  };
}

function memoryStore(): RateLimitStore & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    get: async <T>(key: string) => (counts.get(key) ?? null) as T | null,
    pipeline: () => {
      const ops: Array<() => void> = [];
      return {
        incr: (key: string) => ops.push(() => counts.set(key, (counts.get(key) ?? 0) + 1)),
        expire: () => undefined,
        exec: async () => ops.forEach((op) => op()),
      };
    },
  };
}

async function hits(n: number, store: RateLimitStore | null, fallback: InstanceWindow, key = 'k') {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await checkRateLimit({ store, key, max: MAX, windowSec: 60, fallback }));
  return out;
}

describe('checkRateLimit', () => {
  it('limits through the per-instance window when the shared store throws', async () => {
    const errors: unknown[] = [];
    const fallback = new InstanceWindow(MAX, 60_000);
    const results = [];
    for (let i = 0; i < MAX + 2; i++) {
      results.push(await checkRateLimit({ store: failingStore(), key: 'k', max: MAX, windowSec: 60, fallback, onStoreError: (e) => errors.push(e) }));
    }
    expect(results.map((r) => r.limited)).toEqual([false, false, false, true, true]);
    expect(results.every((r) => r.source === 'instance')).toBe(true);
    expect(errors).toHaveLength(MAX + 2);
  });

  it('limits through the per-instance window when there is no shared store', async () => {
    const results = await hits(MAX + 1, null, new InstanceWindow(MAX, 60_000));
    expect(results.map((r) => r.limited)).toEqual([false, false, false, true]);
  });

  it('uses the shared store when it answers, and does not touch the instance window', async () => {
    const store = memoryStore();
    const fallback = new InstanceWindow(MAX, 60_000);
    const results = await hits(MAX + 1, store, fallback);
    expect(results.map((r) => [r.limited, r.source])).toEqual([
      [false, 'shared'],
      [false, 'shared'],
      [false, 'shared'],
      [true, 'shared'],
    ]);
    expect(store.counts.get('k')).toBe(MAX);
    expect(fallback.hit('k').limited).toBe(false);
  });

  it('keeps separate keys separate', async () => {
    const fallback = new InstanceWindow(MAX, 60_000);
    await hits(MAX, null, fallback, 'a');
    expect((await hits(1, null, fallback, 'a'))[0].limited).toBe(true);
    expect((await hits(1, null, fallback, 'b'))[0].limited).toBe(false);
  });
});

describe('InstanceWindow', () => {
  it('opens a new window after the window length', () => {
    let t = 0;
    const w = new InstanceWindow(1, 1000, 100, () => t);
    expect(w.hit('k').limited).toBe(false);
    expect(w.hit('k').limited).toBe(true);
    t = 1000;
    expect(w.hit('k').limited).toBe(false);
  });

  it('holds at most maxKeys windows', () => {
    const t = 0;
    const w = new InstanceWindow(1, 1000, 2, () => t);
    w.hit('a');
    w.hit('b');
    w.hit('c');
    // 'a' was the oldest live window and was dropped to make room.
    expect(w.hit('a').limited).toBe(false);
    expect(w.hit('c').limited).toBe(true);
  });
});
