/*
 * The header's status is a function of five inputs (D-2). This is its table.
 */
import { describe, it, expect } from 'vitest';
import { shellStatus, STATUS_COPY, SHELL_STATUSES, type ShellStatusInput } from '../../../src/components/layout/shellStatus';
import { ApiError } from '../../../src/api/errors';
import type { HealthResponse } from '../../../src/api/types';

const ok: HealthResponse = { status: 'ok', version: '0.13.0', uptime_seconds: 10, judge: { enabled: false }, mode: 'real' };
const degraded: HealthResponse = { ...ok, status: 'degraded', storage: 'disconnected' };

const base: ShellStatusInput = { connection: 'connected', visible: true, rateLimitedUntil: null, health: ok, error: null };

describe('shellStatus (D-2): one word from five inputs', () => {
  it('a healthy answer in the foreground is live', () => {
    expect(shellStatus(base)).toBe('live');
  });

  it('a hidden tab is paused', () => {
    expect(shellStatus({ ...base, visible: false })).toBe('paused');
  });

  it('a rate-limit window is paused', () => {
    expect(shellStatus({ ...base, rateLimitedUntil: Date.now() + 5000 })).toBe('paused');
  });

  it("the server's own 'degraded' shows as degraded", () => {
    expect(shellStatus({ ...base, health: degraded })).toBe('degraded');
  });

  it('a client that saw a fetch throw is unreachable, whatever the last health said', () => {
    expect(shellStatus({ ...base, connection: 'unreachable' })).toBe('unreachable');
    expect(shellStatus({ ...base, error: new ApiError('unreachable', '/api/v1/health') })).toBe(
      'unreachable',
    );
  });

  it('a lost session outranks everything', () => {
    expect(shellStatus({ ...base, connection: 'signed-out', visible: false, health: degraded })).toBe('signed-out');
    expect(shellStatus({ ...base, error: new ApiError('unauthorized', '/api/v1/health', { status: 401 }) })).toBe(
      'signed-out',
    );
  });

  it('unreachable outranks paused and degraded', () => {
    expect(shellStatus({ ...base, connection: 'unreachable', visible: false, health: degraded })).toBe('unreachable');
  });

  it('before the first answer, a connected client is live', () => {
    expect(shellStatus({ ...base, health: null })).toBe('live');
  });

  it('every status has a label, a tone and a sentence a reader can act on', () => {
    for (const status of SHELL_STATUSES) {
      const copy = STATUS_COPY[status];
      expect(copy.label.length).toBeGreaterThan(0);
      expect(copy.sentence).toMatch(/[.!]$/);
      expect(['pass', 'muted', 'warn', 'fail']).toContain(copy.tone);
    }
    const sentences = new Set(SHELL_STATUSES.map((s) => STATUS_COPY[s].sentence));
    expect(sentences.size).toBe(SHELL_STATUSES.length);
  });
});
