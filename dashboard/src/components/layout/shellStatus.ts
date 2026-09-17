/*
 * The header's one status, derived from what the server said (arc 7, D-2).
 *
 * Five inputs, one word. Precedence, most serious first: the session is gone
 * (nothing else can be read until sign-in), the server is not answering,
 * refresh is paused (a rate-limit window, or the tab is in the background),
 * the server answered that its storage is down, else live. Pure, so the
 * table below is testable without a browser.
 */
import type { ApiError } from '../../api/errors';
import type { ConnectionState } from '../../api/connection';
import type { HealthResponse } from '../../api/types';

export type ShellStatus = 'live' | 'paused' | 'degraded' | 'unreachable' | 'signed-out';

export const SHELL_STATUSES: readonly ShellStatus[] = ['live', 'paused', 'degraded', 'unreachable', 'signed-out'];

export type StatusTone = 'pass' | 'muted' | 'warn' | 'fail';

export interface ShellStatusInput {
  /** The client's last verdict on the server: from `useConnection()`. */
  connection: ConnectionState;
  /** Is the tab in the foreground? Polling stops while it is not. */
  visible: boolean;
  /** From the health query: set while the server has asked the page to slow down. */
  rateLimitedUntil: number | null;
  /** The last health answer, if any. */
  health: HealthResponse | null;
  /** The health query's own error, if any. */
  error: ApiError | null;
}

export function shellStatus(input: ShellStatusInput): ShellStatus {
  if (input.connection === 'signed-out' || input.error?.kind === 'unauthorized') return 'signed-out';
  if (input.connection === 'unreachable' || input.error?.kind === 'unreachable') return 'unreachable';
  if (input.rateLimitedUntil !== null || !input.visible) return 'paused';
  if (input.health?.status === 'degraded') return 'degraded';
  return 'live';
}

/** The word on the pill, its colour, and the sentence behind it — written for the reader, not the log. */
export const STATUS_COPY: Record<ShellStatus, { label: string; tone: StatusTone; sentence: string }> = {
  live: {
    label: 'live',
    tone: 'pass',
    sentence: 'Iris is answering. Views refresh on their own: the live tail about every 3 seconds, trends about every 30.',
  },
  paused: {
    label: 'paused',
    tone: 'muted',
    sentence:
      'Refresh is paused: this tab is in the background, or the server asked the page to slow down. It resumes by itself.',
  },
  degraded: {
    label: 'degraded',
    tone: 'warn',
    sentence: 'Iris is answering but cannot reach its database. Nothing is stored or read until it recovers.',
  },
  unreachable: {
    label: 'unreachable',
    tone: 'fail',
    sentence: 'Iris did not answer. The server may be stopped, or this address may point somewhere else. The page keeps retrying.',
  },
  'signed-out': {
    label: 'signed out',
    tone: 'warn',
    sentence: 'The session ended. Reload the page to sign in again with the API key.',
  },
};
