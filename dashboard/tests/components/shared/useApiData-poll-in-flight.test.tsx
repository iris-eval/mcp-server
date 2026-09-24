/*
 * useApiData — a poll tick never supersedes a request still in flight.
 *
 * The request-id guard (useApiData-race.test.tsx) discards a stale
 * resolution. Combined with polling it had a second edge: when one fetch
 * took longer than the cadence, the next tick started a new request, took
 * the id, and the pending response was discarded as stale — then the same
 * happened to the new one, and the widget never left its loading (or
 * empty) state. On a server with two weeks of traffic the Drift and Health
 * prior windows (200 moments each, 3.5–5.9 s under the dashboard's own
 * concurrent reads) never rendered; the demo made it visible.
 *
 * Now a tick that finds a request in flight is skipped; a manual refetch
 * still supersedes, on purpose.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useApiData } from '../../../src/api/hooks';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useApiData — polling while a request is in flight', () => {
  it('skips the tick and lets the slow response land', async () => {
    vi.useFakeTimers();
    const slow = deferred<string>();
    let callCount = 0;
    const fetcher = () => {
      callCount++;
      return callCount === 1 ? slow.promise : Promise.resolve(`poll-${callCount}`);
    };

    const { result } = renderHook(() => useApiData<string>(fetcher, 1000));
    expect(callCount).toBe(1);

    // Three cadences pass while the first request is still pending: no new request starts.
    await act(async () => {
      vi.advanceTimersByTime(3500);
    });
    expect(callCount).toBe(1);

    // The slow response lands, and it is the data on screen.
    await act(async () => {
      slow.resolve('first');
    });
    vi.useRealTimers();
    await waitFor(() => expect(result.current.data).toBe('first'));
    expect(result.current.loading).toBe(false);
  });

  it('polls again once the request has landed', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const fetcher = () => {
      callCount++;
      return Promise.resolve(`poll-${callCount}`);
    };
    const { result } = renderHook(() => useApiData<string>(fetcher, 1000));
    await act(async () => {
      await Promise.resolve();
    });
    expect(callCount).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(callCount).toBe(2);
    vi.useRealTimers();
    await waitFor(() => expect(result.current.data).toBe('poll-2'));
  });

  it('a manual refetch still supersedes a request in flight', async () => {
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
    expect(callCount).toBe(2);
    await act(async () => {
      fast.resolve('new');
    });
    await waitFor(() => expect(result.current.data).toBe('new'));
    await act(async () => {
      slow.resolve('old');
      await Promise.resolve();
    });
    expect(result.current.data).toBe('new');
  });
});
