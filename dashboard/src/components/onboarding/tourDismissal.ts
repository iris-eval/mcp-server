/*
 * tourDismissal — the welcome tour's "seen it" flag, kept in the browser.
 *
 * Dismissal used to live only in server preferences. That file is
 * per-server: --demo writes demo-preferences.json, a real install writes
 * preferences.json, IRIS_HOME picks yet another — so the same person on
 * the same browser was walked through the tour again every time they
 * switched between a demo and a real dashboard (#377 item 2). The banner
 * already remembered its dismissal in localStorage; the tour now does the
 * same. The server preference is still written (it survives a cleared
 * browser), and either source counts as dismissed.
 */
export const TOUR_DISMISSED_STORAGE_KEY = 'iris-tour-welcome-dismissed';

export function readTourDismissed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(TOUR_DISMISSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeTourDismissed(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TOUR_DISMISSED_STORAGE_KEY, '1');
  } catch {
    // Storage unavailable (private mode) — the server preference still
    // records the dismissal for this install.
  }
}
