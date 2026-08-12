/*
 * useSeenFailures — the persistence behind "what's NEW since last visit".
 *
 * jsdom provides a real localStorage, so these tests exercise the actual
 * storage path: a fresh hook instance must read back what a previous
 * instance wrote, which is exactly the returning-user scenario.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useSeenFailures,
  SEEN_FAILURES_STORAGE_KEY,
  MAX_SEEN_IDS,
} from '../../../src/hooks/useSeenFailures';

beforeEach(() => {
  window.localStorage.clear();
});

describe('useSeenFailures', () => {
  it('starts with everything unseen', () => {
    const { result } = renderHook(() => useSeenFailures());
    expect(result.current.isSeen('t-1')).toBe(false);
  });

  it('markSeen persists across hook instances (the returning-user path)', () => {
    const first = renderHook(() => useSeenFailures());
    act(() => first.result.current.markSeen('t-1'));
    expect(first.result.current.isSeen('t-1')).toBe(true);
    first.unmount();

    // A fresh mount — as after a browser restart — must read it back.
    const second = renderHook(() => useSeenFailures());
    expect(second.result.current.isSeen('t-1')).toBe(true);
    expect(second.result.current.isSeen('t-2')).toBe(false);
  });

  it('markAllSeen records a batch', () => {
    const { result } = renderHook(() => useSeenFailures());
    act(() => result.current.markAllSeen(['t-1', 't-2', 't-3']));
    expect(result.current.isSeen('t-1')).toBe(true);
    expect(result.current.isSeen('t-2')).toBe(true);
    expect(result.current.isSeen('t-3')).toBe(true);
  });

  it('bounds stored ids to MAX_SEEN_IDS, evicting the oldest', () => {
    const ids = Array.from({ length: MAX_SEEN_IDS + 100 }, (_, i) => `t-${i}`);
    const { result } = renderHook(() => useSeenFailures());
    act(() => result.current.markAllSeen(ids));

    const stored = JSON.parse(
      window.localStorage.getItem(SEEN_FAILURES_STORAGE_KEY) ?? '[]',
    ) as string[];
    expect(stored).toHaveLength(MAX_SEEN_IDS);
    expect(stored).toContain(`t-${MAX_SEEN_IDS + 99}`); // newest kept
    expect(stored).not.toContain('t-0'); // oldest evicted
  });

  it('degrades to everything-unseen when storage holds junk', () => {
    window.localStorage.setItem(SEEN_FAILURES_STORAGE_KEY, '{not json');
    const { result } = renderHook(() => useSeenFailures());
    expect(result.current.isSeen('t-1')).toBe(false);
    // And recovers: the next write replaces the junk.
    act(() => result.current.markSeen('t-1'));
    const stored = JSON.parse(
      window.localStorage.getItem(SEEN_FAILURES_STORAGE_KEY) ?? '[]',
    ) as string[];
    expect(stored).toEqual(['t-1']);
  });
});
