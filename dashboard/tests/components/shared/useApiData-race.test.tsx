/*
 * useApiData stale-data race regression test.
 *
 * Without the request-id discard, a slow earlier fetch could resolve
 * AFTER a newer fetch and overwrite the user-visible data with the
 * stale page's results. Reproduced by:
 *   1. Mount useApiData; first fetch returns a slow promise (in flight).
 *   2. Trigger a refetch; second fetch returns a fast promise.
 *   3. Resolve the fast (newer) promise first → data becomes "new".
 *   4. Resolve the slow (older) promise → MUST be discarded, data stays "new".
 *
 * Without the request-id guard the slow resolution would overwrite
 * the data back to "old" after the user already saw "new".
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useApiData } from '../../../src/api/hooks';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useApiData — stale-data race', () => {
  it('discards a stale resolution that arrives after a newer one', async () => {
    const slow = deferred<string>();
    const fast = deferred<string>();

    let callCount = 0;
    const fetcher = () => {
      callCount++;
      return callCount === 1 ? slow.promise : fast.promise;
    };

    const { result } = renderHook(() => useApiData<string>(fetcher));

    // First fetch is in flight (slow). Trigger a second fetch via refetch.
    await act(async () => {
      result.current.refetch();
    });

    // Resolve the NEWER request first
    await act(async () => {
      fast.resolve('new');
    });
    await waitFor(() => expect(result.current.data).toBe('new'));

    // Now resolve the OLDER request. Without the request-id guard, this
    // would overwrite `data` back to 'old'. The guard discards it.
    await act(async () => {
      slow.resolve('old');
    });

    // Give microtasks a chance to flush, then assert the stale value
    // didn't win.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.data).toBe('new');
    expect(result.current.error).toBeNull();
  });

  it('discards a stale error too — a slow fetcher that throws after a newer success cannot flip error state', async () => {
    const slow = deferred<string>();
    const fast = deferred<string>();

    let callCount = 0;
    const fetcher = () => {
      callCount++;
      return callCount === 1 ? slow.promise : fast.promise;
    };

    const { result } = renderHook(() => useApiData<string>(fetcher));

    await act(async () => {
      result.current.refetch();
    });

    await act(async () => {
      fast.resolve('ok');
    });
    await waitFor(() => expect(result.current.data).toBe('ok'));

    await act(async () => {
      slow.reject(new Error('stale failure'));
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Error state must not flip — the failed older request is irrelevant
    expect(result.current.error).toBeNull();
    expect(result.current.data).toBe('ok');
  });
});
