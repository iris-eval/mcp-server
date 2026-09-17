/*
 * Drift by run (D-6) on a two-cohort fixture: one panel per run with n and
 * the interval on each window, the tested difference or "not compared",
 * and the selector writing the cohort to the URL.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router';
import { axe } from 'jest-axe';
import type { DriftComparison, EvalTrendPoint } from '../../../src/api/types';

const useEvalTrendMock = vi.fn();
const useDriftMock = vi.fn();
vi.mock('../../../src/api/hooks', () => ({
  useEvalTrend: (...args: unknown[]) => useEvalTrendMock(...args),
  useDrift: (...args: unknown[]) => useDriftMock(...args),
  CADENCE: { FAST: 3000, NORMAL: 10000, SLOW: 30000 },
}));

import { CohortPanels, cohortsOf, fmtWindow, MAX_COHORT_PANELS } from '../../../src/components/dashboard/CohortPanels';
import { CohortSelector, resolveCohort } from '../../../src/components/dashboard/CohortSelector';

const bucket = (cohort: string, day: number, passRate: number, evalCount: number): EvalTrendPoint => ({
  timestamp: `2026-09-0${day}T00:00:00Z`,
  avgScore: passRate,
  passRate,
  evalCount,
  cohort,
});

const trend: EvalTrendPoint[] = [bucket('baseline', 1, 0.8, 5), bucket('baseline', 2, 0.8, 5), bucket('candidate', 3, 0.9, 6), bucket('candidate', 4, 0.9, 4)];

const drift = (run: string, over: Partial<DriftComparison> = {}): DriftComparison => ({
  period: '7d',
  run,
  current: { since: 's', until: null, evaluated: 10, passed: 8, passRate: 0.8, interval: { lo: 0.49, hi: 0.943 } },
  prior: { since: 'p', until: 's', evaluated: 10, passed: 10, passRate: 1, interval: { lo: 0.722, hi: 1 } },
  difference: { delta: -0.2, lo: -0.45, hi: 0.05, significant: false },
  enoughEvidence: true,
  minimumPerWindow: 10,
  smallestDetectable: 0.42,
  ...over,
});

const query = <T,>(data: T | null) => ({ data, loading: false, error: null, refetch: vi.fn(), rateLimitedUntil: null });

describe('CohortPanels (D-6)', () => {
  beforeEach(() => {
    useEvalTrendMock.mockReturnValue(query(trend));
    useDriftMock.mockImplementation((params: { run: string }) =>
      params.run === 'candidate'
        ? query(drift('candidate', { prior: { since: 'p', until: 's', evaluated: 0, passed: 0, passRate: null, interval: null }, difference: null, enoughEvidence: false, smallestDetectable: null }))
        : query(drift('baseline')),
    );
  });

  it('one panel per cohort, largest first, each with n and the interval on both windows', () => {
    const { container } = render(<MemoryRouter><CohortPanels period="7d" /></MemoryRouter>);
    const panels = [...container.querySelectorAll('[data-cohort]')].map((p) => p.getAttribute('data-cohort'));
    expect(panels).toEqual(['baseline', 'candidate']);
    const baseline = container.querySelector('[data-cohort="baseline"]')!;
    expect(baseline.querySelector('[data-cohort-n]')?.getAttribute('data-cohort-n')).toBe('10');
    expect(baseline.querySelector('[data-cohort-current]')?.textContent).toBe('8 of 10 passed · 80.0% [49.0%, 94.3%]');
    expect(baseline.querySelector('[data-cohort-prior]')?.textContent).toBe('10 of 10 passed · 100.0% [72.2%, 100.0%]');
    expect(baseline.querySelector('[data-cohort-difference]')?.textContent).toBe('-20.0 pts [-45.0, 5.0]');
    expect(baseline.querySelector('[data-cohort-verdict]')?.textContent).toBe('NOT DISTINGUISHABLE');
    expect(useEvalTrendMock).toHaveBeenCalledWith('7d', 'run');
    expect(useDriftMock).toHaveBeenCalledWith({ period: '7d', run: 'baseline' });
  });

  it('a cohort with an empty prior window is not compared, and says so', () => {
    const { container } = render(<MemoryRouter><CohortPanels period="7d" /></MemoryRouter>);
    const candidate = container.querySelector('[data-cohort="candidate"]')!;
    expect(candidate.querySelector('[data-cohort-prior]')?.textContent).toBe('no evaluations');
    expect(candidate.querySelector('[data-cohort-verdict]')?.textContent).toBe('NOT COMPARED');
    expect(candidate.querySelector('[data-cohort-difference]')).toBeNull();
  });

  it('a significant drop reads WORSE', () => {
    useDriftMock.mockImplementation(() => query(drift('baseline', { difference: { delta: -0.3, lo: -0.5, hi: -0.1, significant: true } })));
    const { container } = render(<MemoryRouter><CohortPanels period="7d" /></MemoryRouter>);
    expect(container.querySelector('[data-cohort="baseline"] [data-cohort-verdict]')?.textContent).toBe('WORSE');
  });

  it('with no run in the window it says how to get one', () => {
    useEvalTrendMock.mockReturnValue(query([bucket('', 1, 0.5, 3)].map((b) => ({ ...b, cohort: null }))));
    const { container } = render(<MemoryRouter><CohortPanels period="7d" /></MemoryRouter>);
    expect(container.querySelector('[data-cohort-empty]')).not.toBeNull();
  });

  it('cohortsOf: largest first, capped, the rest named', () => {
    const many = Array.from({ length: MAX_COHORT_PANELS + 2 }, (_, i) => bucket(`r${i}`, 1, 0.5, i + 1));
    const { drawn, named } = cohortsOf(many);
    expect(drawn).toHaveLength(MAX_COHORT_PANELS);
    expect(drawn[0]).toBe(`r${MAX_COHORT_PANELS + 1}`);
    expect(named).toHaveLength(2);
    expect(fmtWindow({ since: 's', until: null, evaluated: 0, passed: 0, passRate: null, interval: null })).toBe('no evaluations');
  });

  it('has no axe violations', async () => {
    const { container } = render(<MemoryRouter><CohortPanels period="7d" /></MemoryRouter>);
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('CohortSelector (D-6)', () => {
  function Probe() {
    const [sp] = useSearchParams();
    return <span data-testid="cohort">{resolveCohort(sp) ?? 'all'}</span>;
  }

  it('writes the cohort to the URL and clears it again', () => {
    const { container, getByTestId } = render(
      <MemoryRouter initialEntries={['/?view=drift&period=7d']}>
        <CohortSelector />
        <Probe />
      </MemoryRouter>,
    );
    expect(getByTestId('cohort').textContent).toBe('all');
    fireEvent.click(container.querySelector('[data-cohort-option="run"]')!);
    expect(getByTestId('cohort').textContent).toBe('run');
    expect(container.querySelector('[data-cohort-option="run"]')?.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(container.querySelector('[data-cohort-option="all"]')!);
    expect(getByTestId('cohort').textContent).toBe('all');
  });
});
