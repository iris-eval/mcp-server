/*
 * The one place the shell learns whether Iris is answering (arc 7, D-2).
 *
 * Every response the client sees reports here. An answer of any status means
 * the server is reachable, a fetch that throws means it is not, and a 401 or
 * 403 means the session is gone. The header reads the store; no page has to
 * carry its own notion of "connected", and the pill can never say "live" from
 * a constant again.
 *
 * `since` is when the current state began — the header's tooltip can say how
 * long the server has been unreachable without a second clock.
 */
import { useSyncExternalStore } from 'react';

export type ConnectionState = 'connected' | 'unreachable' | 'signed-out';

export interface ConnectionSnapshot {
  state: ConnectionState;
  since: number;
}

let snapshot: ConnectionSnapshot = { state: 'connected', since: Date.now() };
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Called by the client on every answer. A repeat of the current state is a no-op: no render, no new `since`. */
export function reportConnection(state: ConnectionState): void {
  if (snapshot.state === state) return;
  snapshot = { state, since: Date.now() };
  notify();
}

export function connectionSnapshot(): ConnectionSnapshot {
  return snapshot;
}

export function subscribeConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: back to the initial state, listeners told. */
export function resetConnection(): void {
  snapshot = { state: 'connected', since: Date.now() };
  notify();
}

export function useConnection(): ConnectionSnapshot {
  return useSyncExternalStore(subscribeConnection, connectionSnapshot, connectionSnapshot);
}
