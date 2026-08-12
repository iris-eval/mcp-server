/*
 * FailuresView — the landing surface.
 *
 * The API layer is mocked (useFailures); the seen/unseen layer is REAL —
 * it runs against jsdom's localStorage, so the click-through → seen →
 * persists-across-remount path is exercised end to end, not stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { FailureQueryResult, RankedFailure } from '../../../src/api/types';
import { SEEN_FAILURES_STORAGE_KEY } from '../../../src/hooks/useSeenFailures';

const useFailuresMock = vi.fn();

vi.mock('../../../src/api/hooks', () => ({
  useFailures: (...args: unknown[]) => useFailuresMock(...args),
}));

import { FailuresView } from '../../../src/components/dashboard/FailuresView';

function makeFailure(id: string, overrides: Partial<RankedFailure> = {}): RankedFailure {
  return {
    id,
    traceId: id,
    agentName: `agent-${id}`,
    timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    output: 'Sure! The SSN you asked for is 123-45-6789.',
    verdict: 'fail',
    overallScore: 0,
    evalCount: 1,
    ruleSnapshot: { failed: ['no_pii'], skipped: [], passedCount: 0, totalCount: 1 },
    significance: {
      kind: 'safety-violation',
      score: 1,
      label: 'Safety: no_pii',
      reason: 'A safety rule failed.',
    },
    rankScore: 0.97,
    ...overrides,
  };
}

function apiResult(failures: RankedFailure[], { total }: { total?: number } = {}): {
  data: FailureQueryResult;
  loading: boolean;
  error: null;
  rateLimitedUntil: null;
  refetch: () => void;
} {
  return {
    data: {
      failures,
      scanned: total ?? failures.length,
      total: total ?? failures.length,
      limit: 50,
    },
    loading: false,
    error: null,
    rateLimitedUntil: null,
    refetch: vi.fn(),
  };
}

function renderView() {
  return render(
    <MemoryRouter>
      <FailuresView />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  useFailuresMock.mockReset();
});

describe('FailuresView', () => {
  it('renders each failure with agent, failed rule, and time — and links to the detail view', () => {
    useFailuresMock.mockReturnValue(apiResult([makeFailure('t-1'), makeFailure('t-2')]));
    renderView();

    expect(screen.getByText('agent-t-1')).toBeInTheDocument();
    expect(screen.getByText('agent-t-2')).toBeInTheDocument();
    expect(screen.getAllByText('no_pii')).toHaveLength(2); // rule chip per row
    expect(screen.getAllByText('1h ago')).toHaveLength(2);

    const links = screen.getAllByRole('link');
    expect(links.some((l) => l.getAttribute('href') === '/moments/t-1')).toBe(true);
    expect(links.some((l) => l.getAttribute('href') === '/moments/t-2')).toBe(true);
  });

  it('marks unvisited failures NEW and counts them in the header', () => {
    useFailuresMock.mockReturnValue(apiResult([makeFailure('t-1'), makeFailure('t-2')]));
    renderView();

    expect(screen.getAllByText('NEW')).toHaveLength(2);
    expect(screen.getByText('2 new since you last looked')).toBeInTheDocument();
  });

  it('clicking through a failure marks it seen — and it stays seen on remount', () => {
    useFailuresMock.mockReturnValue(apiResult([makeFailure('t-1'), makeFailure('t-2')]));
    const { unmount } = renderView();

    fireEvent.click(screen.getByText('agent-t-1')); // inside the card's detail link
    expect(screen.getAllByText('NEW')).toHaveLength(1);
    expect(screen.getByText('1 new since you last looked')).toBeInTheDocument();

    // Returning user: fresh mount, same localStorage — t-1 stays seen.
    unmount();
    renderView();
    expect(screen.getAllByText('NEW')).toHaveLength(1);
    expect(
      JSON.parse(window.localStorage.getItem(SEEN_FAILURES_STORAGE_KEY) ?? '[]'),
    ).toContain('t-1');
  });

  it('"Mark all seen" clears every NEW tag', () => {
    useFailuresMock.mockReturnValue(apiResult([makeFailure('t-1'), makeFailure('t-2')]));
    renderView();

    fireEvent.click(screen.getByRole('button', { name: 'Mark all seen' }));
    expect(screen.queryByText('NEW')).not.toBeInTheDocument();
    expect(screen.getByText('nothing new since you last looked')).toBeInTheDocument();
  });

  it('with no runs at all, points to demo mode and the quickstart', () => {
    useFailuresMock.mockReturnValue(apiResult([], { total: 0 }));
    renderView();

    expect(screen.getByText('Nothing has run yet')).toBeInTheDocument();
    // The advertised command must stay in lockstep with the real CLI flag
    // shipped in src/index.ts (--demo) — it hard-fails if the flag renames.
    expect(screen.getByText('npx @iris-eval/mcp-server --demo')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'quickstart' })).toHaveAttribute(
      'href',
      'https://github.com/iris-eval/mcp-server#quickstart',
    );
  });

  it('with runs but no failures, says so instead of showing onboarding', () => {
    useFailuresMock.mockReturnValue(apiResult([], { total: 12 }));
    renderView();

    expect(screen.getByText('No failures in your recent runs')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'quickstart' })).not.toBeInTheDocument();
  });

  it('shows the error state with a retry action when the fetch fails', () => {
    const refetch = vi.fn();
    useFailuresMock.mockReturnValue({
      data: null,
      loading: false,
      error: 'API error: 500 Internal Server Error',
      rateLimitedUntil: null,
      refetch,
    });
    renderView();

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load failures');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
