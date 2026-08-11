/*
 * useSeenFailures — per-failure seen/unseen state, persisted locally.
 *
 * The failure-first landing view marks rows the user has not looked at
 * yet, so a returning user sees what is NEW since their last visit.
 * This is a single-user local tool, so localStorage is the right v0
 * store: no server round-trip, survives restarts, and per-browser state
 * is exactly per-user state here. (Server-mediated preferences carry
 * cross-cutting settings like theme; seen-ids are high-churn row state
 * and would bloat that store.)
 *
 * Storage shape: JSON array of failure ids (= trace ids), most recently
 * seen last. Bounded to MAX_SEEN_IDS — beyond that the oldest entries
 * drop off, which is safe because the landing list only surfaces recent
 * failures anyway; an evicted id could only re-show as "new" if a
 * months-old failure re-entered the top of the list.
 */
import { useCallback, useState } from 'react';

export const SEEN_FAILURES_STORAGE_KEY = 'iris.seenFailures.v1';

/** Bound on stored ids — keeps the entry comfortably under localStorage quotas. */
export const MAX_SEEN_IDS = 500;

function readSeenIds(): string[] {
  try {
    const raw = window.localStorage.getItem(SEEN_FAILURES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    // Unreadable storage (privacy mode, corrupted entry) degrades to
    // "everything is new" — annoying once, never wrong twice.
    return [];
  }
}

function writeSeenIds(ids: string[]): void {
  try {
    window.localStorage.setItem(
      SEEN_FAILURES_STORAGE_KEY,
      JSON.stringify(ids.slice(-MAX_SEEN_IDS)),
    );
  } catch {
    // Quota/permission failures are non-fatal — state just won't persist.
  }
}

export interface UseSeenFailuresResult {
  /** True if the failure id has been seen (clicked through or marked). */
  isSeen: (id: string) => boolean;
  /** Record one failure as seen. Idempotent. */
  markSeen: (id: string) => void;
  /** Record a batch as seen — the "mark all seen" action. */
  markAllSeen: (ids: string[]) => void;
}

export function useSeenFailures(): UseSeenFailuresResult {
  // Lazy init so the storage read happens once per mount, not per render.
  const [seenIds, setSeenIds] = useState<ReadonlySet<string>>(
    () => new Set(readSeenIds()),
  );

  const isSeen = useCallback((id: string) => seenIds.has(id), [seenIds]);

  const markSeen = useCallback((id: string) => {
    setSeenIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      writeSeenIds([...next]);
      return next;
    });
  }, []);

  const markAllSeen = useCallback((ids: string[]) => {
    setSeenIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of ids) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      if (!changed) return prev;
      writeSeenIds([...next]);
      return next;
    });
  }, []);

  return { isSeen, markSeen, markAllSeen };
}
