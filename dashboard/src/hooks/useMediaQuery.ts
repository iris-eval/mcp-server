/*
 * useMediaQuery — subscribe to a CSS media query.
 *
 * Returns true when the query matches. Reactive: updates when the
 * viewport crosses a breakpoint or the user changes their OS-level
 * preference (e.g., toggling reduced motion).
 */
import { useEffect, useState } from 'react';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    // Modern browsers
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}
