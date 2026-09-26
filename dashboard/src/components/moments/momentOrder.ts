/*
 * The order of the Decision Moments list (#409).
 *
 * Ranked by significance is the default: the server ranks the moments of a
 * window of recent traces, most significant first, newest first among
 * equals. `?sort=newest` is the plain newest-first stream. Kept apart from
 * the page so the rules are testable without rendering it.
 */
import type { MomentQueryResult } from '../../api/types';

/** The two orders the page offers. */
export type MomentOrder = 'significance' | 'newest';

/** The order a URL asks for; anything but `sort=newest` is the ranked default. */
export function orderOf(searchParams: URLSearchParams): MomentOrder {
  return searchParams.get('sort') === 'newest' ? 'newest' : 'significance';
}

const traces = (n: number): string => `${n.toLocaleString('en-US')} trace${n === 1 ? '' : 's'}`;

/**
 * The sentence that says how far back the ranking reached. A ranking over
 * part of the history reads as the whole of it unless it says otherwise,
 * so the window is always stated. Null when the list is newest first or
 * the window read nothing.
 */
export function rankingNote(data: Pick<MomentQueryResult, 'sortBy' | 'window'>): string | null {
  if (data.sortBy !== 'significance' || !data.window || data.window.scanned === 0) return null;
  const { scanned, tracesInRange } = data.window;
  if (scanned >= tracesInRange) return `Ranked by significance across ${scanned === 1 ? 'the' : 'all'} ${traces(scanned)} in range.`;
  return (
    `Ranked by significance within the last ${traces(scanned)} of ${tracesInRange.toLocaleString('en-US')}. ` +
    'Older moments are not in this ranking: narrow the agent or time range to reach them, or switch to newest first.'
  );
}
