/*
 * The in-widget error (D-1): one component, one sentence per kind, a retry
 * where a retry can help, a sign-in where a key is needed, and no axe
 * violations in any state.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import { ApiError, RateLimitError } from '../../../src/api/errors';
import { QueryError, KIND_LABEL } from '../../../src/components/shared/QueryError';

const KINDS = ['unreachable', 'unauthorized', 'not-found', 'rate-limited', 'server-error', 'bad-request'] as const;

describe('QueryError', () => {
  it('renders a distinct heading and the error\'s own sentence for every kind, as an alert', async () => {
    const seen = new Set<string>();
    for (const kind of KINDS) {
      const error = kind === 'rate-limited' ? new RateLimitError(5000) : new ApiError(kind, '/api/v1/x', { status: 500, detail: 'why' });
      const { unmount, container } = render(<QueryError error={error} what="the thing" />);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveAttribute('data-error-kind', kind);
      expect(alert.textContent).toContain(KIND_LABEL[kind]);
      expect(alert.textContent).toContain(error.message);
      seen.add(KIND_LABEL[kind]);
      expect(await axe(container)).toHaveProperty('violations', []);
      unmount();
    }
    expect(seen.size).toBe(KINDS.length);
  });

  it('offers a retry that calls back, except when only a key would help', () => {
    const onRetry = vi.fn();
    render(<QueryError error={new ApiError('server-error', '/x', { status: 500 })} what="failures" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('an unauthorized error shows the sign-in path and no retry', () => {
    render(<QueryError error={new ApiError('unauthorized', '/x', { status: 401 })} what="failures" onRetry={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByText('Sign in')).toBeInTheDocument();
  });

  it('a rate-limited error with a schedule shows the countdown banner instead', () => {
    render(<QueryError error={new RateLimitError(30_000)} what="failures" rateLimitedUntil={Date.now() + 30_000} />);
    expect(screen.queryByRole('alert')?.getAttribute('data-error-kind')).not.toBe('rate-limited');
    expect(document.body.textContent).toMatch(/rate limit/i);
  });
});
