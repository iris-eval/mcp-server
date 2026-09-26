/*
 * The Moments page ranks by significance by default and says how far back
 * the ranking reached (#409). The API layer is mocked; what is asserted is
 * what the page asks the server for, and what it tells the reader.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { DecisionMoment, MomentQueryResult } from '../../../src/api/types';
import { orderOf, rankingNote } from '../../../src/components/moments/momentOrder';

const useMomentsMock = vi.fn();

vi.mock('../../../src/api/hooks', () => ({
  CADENCE: { FAST: 3000, NORMAL: 10000, SLOW: 30000 },
  useMoments: (...args: unknown[]) => useMomentsMock(...args),
  useFilters: () => ({ data: { agent_names: [] }, loading: false, error: null, refetch: vi.fn() }),
}));
vi.mock('../../../src/hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: { momentFilters: {}, archivedMoments: [] },
    displayPath: '/tmp/iris/preferences.json',
    loading: false,
    error: null,
    patch: vi.fn(async () => undefined),
    refetch: vi.fn(),
  }),
}));

import { MomentsTimelinePage } from '../../../src/components/moments/MomentsTimelinePage';

function moment(id: string, kind: DecisionMoment['significance']['kind'], score: number): DecisionMoment {
  return {
    id,
    traceId: id,
    agentName: 'support-bot',
    timestamp: '2026-09-01T00:30:00.000Z',
    verdict: kind === 'normal-pass' ? 'pass' : 'fail',
    overallScore: 0.5,
    evalCount: 1,
    ruleSnapshot: { failed: [], skipped: [], passedCount: 1, totalCount: 1 },
    significance: { kind, score, label: kind, reason: kind },
  };
}

function result(data: MomentQueryResult) {
  return { data, loading: false, error: null, refetch: vi.fn(), rateLimitedUntil: null };
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <MomentsTimelinePage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useMomentsMock.mockReset();
});

describe('MomentsTimelinePage order', () => {
  it('asks for a significance ranking by default, polled at the window cadence, and states the window', () => {
    useMomentsMock.mockReturnValue(
      result({
        moments: [moment('t030', 'safety-violation', 1), moment('t239', 'normal-pass', 0.05)],
        total: 240,
        limit: 50,
        offset: 0,
        sortBy: 'significance',
        window: { size: 500, scanned: 500, tracesInRange: 1200, newest: '2026-09-01T03:59:00.000Z', oldest: '2026-09-01T00:00:00.000Z' },
      }),
    );
    renderAt('/moments');
    const [params, cadence] = useMomentsMock.mock.calls[0] as [Record<string, string>, number];
    expect(params).toMatchObject({ sort_by: 'significance', limit: '50' });
    expect(cadence).toBe(10000);
    expect(screen.getByTestId('ranking-note').textContent).toBe(
      'Ranked by significance within the last 500 traces of 1,200. Older moments are not in this ranking: narrow the agent or time range to reach them, or switch to newest first.',
    );
    expect((screen.getByLabelText('Order moments') as HTMLSelectElement).value).toBe('significance');
  });

  it('?sort=newest asks for the plain stream at the live cadence and shows no ranking note', () => {
    useMomentsMock.mockReturnValue(result({ moments: [moment('t239', 'normal-pass', 0.05)], total: 240, limit: 50, offset: 0 }));
    renderAt('/moments?sort=newest');
    const [params, cadence] = useMomentsMock.mock.calls[0] as [Record<string, string>, number];
    expect(params.sort_by).toBeUndefined();
    expect(cadence).toBe(3000);
    expect(screen.queryByTestId('ranking-note')).toBeNull();
    expect((screen.getByLabelText('Order moments') as HTMLSelectElement).value).toBe('newest');
  });

  it('switching the order changes the request', () => {
    useMomentsMock.mockReturnValue(result({ moments: [], total: 0, limit: 50, offset: 0, sortBy: 'significance', window: { size: 500, scanned: 0, tracesInRange: 0 } }));
    renderAt('/moments');
    fireEvent.change(screen.getByLabelText('Order moments'), { target: { value: 'newest' } });
    const last = useMomentsMock.mock.calls.at(-1) as [Record<string, string>, number];
    expect(last[0].sort_by).toBeUndefined();
  });
});

describe('momentOrder', () => {
  it('orderOf: ranked unless the URL asks for newest', () => {
    expect(orderOf(new URLSearchParams(''))).toBe('significance');
    expect(orderOf(new URLSearchParams('sort=newest'))).toBe('newest');
    expect(orderOf(new URLSearchParams('sort=anything-else'))).toBe('significance');
  });

  it('rankingNote: the whole range, part of it, or nothing to say', () => {
    expect(rankingNote({ sortBy: 'significance', window: { size: 500, scanned: 240, tracesInRange: 240 } })).toBe(
      'Ranked by significance across all 240 traces in range.',
    );
    expect(rankingNote({ sortBy: 'significance', window: { size: 500, scanned: 1, tracesInRange: 1 } })).toBe(
      'Ranked by significance across the 1 trace in range.',
    );
    expect(rankingNote({ sortBy: 'significance', window: { size: 500, scanned: 0, tracesInRange: 0 } })).toBeNull();
    expect(rankingNote({})).toBeNull();
  });
});
