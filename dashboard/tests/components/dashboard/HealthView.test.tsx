/*
 * HealthView — the total-cost tile names the estimated part of the total.
 *
 * Since 0.20.0 a trace that reports no cost is stored with one Iris
 * estimated from its tokens at list price; GET /api/v1/eval-stats carries
 * that part as `estimatedCost`. The tile must say how much of its total is
 * an estimate, and say nothing when none of it is. The API layer is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { EvalStats } from '../../../src/api/types';

const useEvalStatsMock = vi.fn();
const idle = () => ({ data: null, loading: false, error: null, refetch: vi.fn(), rateLimitedUntil: null });

vi.mock('../../../src/api/hooks', () => ({
  CADENCE: { NORMAL: 10_000, SLOW: 30_000, FAST: 5_000 },
  useEvalStats: (...args: unknown[]) => useEvalStatsMock(...args),
  useEvalTrend: () => idle(),
  useMoments: () => idle(),
  useAuditLog: () => idle(),
  useBuiltInRules: () => idle(),
}));

import { HealthView } from '../../../src/components/dashboard/HealthView';

const stats = (over: Partial<EvalStats>): EvalStats => ({
  passRate: 0.9,
  avgScore: 0.9,
  totalEvals: 10,
  safetyViolations: { pii: 0, injection: 0, hallucination: 0 },
  totalCost: 0.0385,
  agentCount: 1,
  period: '30d',
  ...over,
});

function costTile(container: HTMLElement): HTMLElement {
  const tile = [...container.querySelectorAll<HTMLElement>('.stat-tile')].find((el) => el.querySelector('.stat-tile__header')?.textContent === 'Total cost');
  expect(tile, 'the Total cost tile renders').toBeDefined();
  return tile!;
}

describe('HealthView · total cost', () => {
  beforeEach(() => useEvalStatsMock.mockReset());

  it('names the estimated part of the total as est.', () => {
    useEvalStatsMock.mockReturnValue({ ...idle(), data: stats({ estimatedCost: 0.0285 }) });
    const { container } = render(<MemoryRouter><HealthView /></MemoryRouter>);
    const tile = costTile(container);
    expect(tile.textContent).toContain('$0.0385');
    expect(tile.textContent).toContain('· $0.0285 est.');
  });

  it('says nothing about estimates when none of the total was estimated, or the server does not report it', () => {
    for (const data of [stats({ estimatedCost: 0 }), stats({})]) {
      useEvalStatsMock.mockReturnValue({ ...idle(), data });
      const { container, unmount } = render(<MemoryRouter><HealthView /></MemoryRouter>);
      const tile = costTile(container);
      expect(tile.textContent).toContain('$0.0385');
      expect(tile.textContent).not.toContain('est.');
      unmount();
    }
  });
});
