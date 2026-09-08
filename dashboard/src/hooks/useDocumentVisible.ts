/*
 * Whether this tab is in the foreground (arc 7, D-2).
 *
 * `usePolling` already skips its tick while the document is hidden; this
 * hook lets the header say so ("paused") instead of showing "live" over a
 * feed that is not moving. Subscribes to `visibilitychange`, nothing else.
 */
import { useSyncExternalStore } from 'react';

function subscribe(callback: () => void): () => void {
  document.addEventListener('visibilitychange', callback);
  return () => document.removeEventListener('visibilitychange', callback);
}

function read(): boolean {
  return document.visibilityState === 'visible';
}

function serverRead(): boolean {
  return true;
}

export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribe, read, serverRead);
}
