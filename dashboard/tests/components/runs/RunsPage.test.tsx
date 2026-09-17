/*
 * The runs page (D-5): the list with its links, the empty state, and the
 * compare action that calls POST /api/v1/compare and renders the answer.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { axe } from 'jest-axe';
import type { CompareRunsResult, RunSummaryRow } from '../../../src/api/types';

const useRunsMock = vi.fn();
vi.mock('../../../src/api/hooks', () => ({
  useRuns: (...args: unknown[]) => useRunsMock(...args),
  CADENCE: { FAST: 3000, NORMAL: 10000, SLOW: 30000 },
}));

const compareRunsMock = vi.fn();
vi.mock('../../../src/api/client', () => ({
  api: { compareRuns: (...args: unknown[]) => compareRunsMock(...args) },
}));

import { RunsPage } from '../../../src/components/runs/RunsPage';

const run = (runId: string, passed: number, evaluated: number): RunSummaryRow => ({
  runId,
  label: null,
  reevaluationOf: null,
  traces: evaluated,
  evaluated,
  passed,
  agentNames: ['support-bot'],
  engineVersions: ['0.13.0'],
  rulesetHashes: ['3f2a91c0'],
  startedAt: '2026-09-01T00:00:00Z',
  lastActivityAt: '2026-09-01T00:10:00Z',
});

const comparison: CompareRunsResult = {
  comparable: true,
  incomparable_because: [],
  forced: false,
  method: 'paired-mcnemar',
  before: { run_id: 'baseline', n: 10, passed: 8, rate: 0.8, interval: { lo: 0.49, hi: 0.94 }, agent_names: ['support-bot'], engine_versions: ['0.13.0'], ruleset_hashes: ['3f2a91c0'], config_hashes: ['9b'], superseded: 0 },
  after: { run_id: 'candidate', n: 10, passed: 9, rate: 0.9, interval: { lo: 0.6, hi: 0.98 }, agent_names: ['support-bot'], engine_versions: ['0.13.0'], ruleset_hashes: ['3f2a91c0'], config_hashes: ['9b'], superseded: 0 },
  difference: { delta: 0.1, lo: -0.2, hi: 0.4, significant: false },
  paired: { method: 'mcnemar-exact', b: 1, c: 2, concordant: 7, pairs: 10, p_value: 1, significant: false },
  worse: false,
  better: false,
  smallest_detectable: 0.42,
  regressions: [],
  improvements: [{ rule: 'min_output_length', failed_before: 2, failed_after: 1, delta: -1 }],
  summary: 'Not enough evidence to call it either way.',
};

function page() {
  return render(
    <MemoryRouter>
      <RunsPage />
    </MemoryRouter>,
  );
}

describe('RunsPage (D-5)', () => {
  beforeEach(() => {
    useRunsMock.mockReturnValue({
      data: { runs: [run('baseline', 8, 10), run('candidate', 9, 10)], count: 2 },
      loading: false,
      error: null,
      refetch: vi.fn(),
      rateLimitedUntil: null,
    });
    compareRunsMock.mockReset();
  });

  it('lists every run with a link to it and its counts', () => {
    const { container } = page();
    expect(container.querySelector('[data-run-link="baseline"]')?.getAttribute('href')).toBe('/runs/baseline');
    expect(container.querySelector('[data-run-link="candidate"]')).not.toBeNull();
    expect(container.textContent).toContain('8 of 10 passed');
    expect(container.textContent).toContain('80.0%');
  });

  it('the empty state explains what a run is and how to make one', () => {
    useRunsMock.mockReturnValue({ data: { runs: [], count: 0 }, loading: false, error: null, refetch: vi.fn(), rateLimitedUntil: null });
    page();
    expect(screen.getByText('No runs yet')).toBeTruthy();
    expect(screen.getByText(/case_key/)).toBeTruthy();
  });

  it('compare: the button waits for both runs, posts them, and renders the answer', async () => {
    compareRunsMock.mockResolvedValue(comparison);
    const { container } = page();
    const submit = container.querySelector('[data-compare-submit]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(container.querySelector('[data-compare-before]')!, { target: { value: 'baseline' } });
    fireEvent.change(container.querySelector('[data-compare-after]')!, { target: { value: 'candidate' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(container.querySelector('[data-comparison]')).not.toBeNull());
    expect(compareRunsMock).toHaveBeenCalledWith({ before: 'baseline', after: 'candidate', force: undefined });
    expect(container.querySelector('[data-comparison-verdict]')?.textContent).toBe('NOT DISTINGUISHABLE');
    expect(container.querySelector('[data-smallest-detectable]')?.textContent).toBe('detects ≥ 42.0 pts');
  });

  it('compare: the force box reaches the request', async () => {
    compareRunsMock.mockResolvedValue({ ...comparison, forced: true, comparable: false, incomparable_because: ['different agents'] });
    const { container } = page();
    fireEvent.change(container.querySelector('[data-compare-before]')!, { target: { value: 'baseline' } });
    fireEvent.change(container.querySelector('[data-compare-after]')!, { target: { value: 'candidate' } });
    fireEvent.click(container.querySelector('[data-compare-force]')!);
    fireEvent.click(container.querySelector('[data-compare-submit]')!);
    await waitFor(() => expect(compareRunsMock).toHaveBeenCalled());
    expect(compareRunsMock).toHaveBeenCalledWith({ before: 'baseline', after: 'candidate', force: true });
    await waitFor(() => expect(container.querySelector('[data-forced]')).not.toBeNull());
  });

  it('compare: a failed request renders its typed error in place', async () => {
    compareRunsMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { container } = page();
    fireEvent.change(container.querySelector('[data-compare-before]')!, { target: { value: 'baseline' } });
    fireEvent.change(container.querySelector('[data-compare-after]')!, { target: { value: 'candidate' } });
    fireEvent.click(container.querySelector('[data-compare-submit]')!);
    await waitFor(() => expect(container.querySelector('[data-error-kind]')).not.toBeNull());
    expect(container.querySelector('[data-comparison]')).toBeNull();
  });

  it('has no axe violations, listed and empty', async () => {
    const { container, unmount } = page();
    expect((await axe(container)).violations).toEqual([]);
    unmount();
    useRunsMock.mockReturnValue({ data: { runs: [], count: 0 }, loading: false, error: null, refetch: vi.fn(), rateLimitedUntil: null });
    const { container: empty } = page();
    expect((await axe(empty)).violations).toEqual([]);
  });
});
