/*
 * The case and run detail pages (D-5): a flaky case says so; a run shows its
 * counts and links each case.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { axe } from 'jest-axe';

const useCaseMock = vi.fn();
const useRunMock = vi.fn();
vi.mock('../../../src/api/hooks', () => ({
  useCase: (...args: unknown[]) => useCaseMock(...args),
  useRun: (...args: unknown[]) => useRunMock(...args),
  CADENCE: { FAST: 3000, NORMAL: 10000, SLOW: 30000 },
}));

import { CasePage } from '../../../src/components/runs/CasePage';
import { RunDetailPage } from '../../../src/components/runs/RunDetailPage';

function at(path: string, element: React.ReactElement, pattern: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={pattern} element={element} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CasePage (D-5)', () => {
  beforeEach(() => {
    useCaseMock.mockReturnValue({
      data: {
        caseKey: 'case-0',
        attempts: 2,
        passed: 1,
        flaky: true,
        runs: ['baseline', 'candidate'],
        results: [
          { evalId: 'e1', traceId: 't1', caseKey: 'case-0', runId: 'baseline', passed: false, createdAt: '2026-09-01T00:00:00Z' },
          { evalId: 'e2', traceId: 't2', caseKey: 'case-0', runId: 'candidate', passed: true, createdAt: '2026-09-02T00:00:00Z' },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
      rateLimitedUntil: null,
    });
  });

  it('a flaky case: the attempts, the word, and every attempt with its run', () => {
    const { container } = at('/cases/case-0', <CasePage />, '/cases/:key');
    expect(container.querySelector('[data-case-detail="case-0"]')).not.toBeNull();
    expect(container.querySelector('[data-case-attempts]')?.textContent).toBe('1 of 2 attempts passed');
    expect(container.querySelector('[data-case-flaky="true"]')?.textContent).toBe('flaky');
    expect(container.textContent).toContain('across 2 runs');
    expect(container.querySelectorAll('a[href^="/runs/"]')).toHaveLength(2);
  });

  it('narrowed to one run, the page says so; the hook gets the run', () => {
    at('/cases/case-0?run=baseline', <CasePage />, '/cases/:key');
    expect(useCaseMock).toHaveBeenLastCalledWith('case-0', 'baseline');
  });

  it('has no axe violations', async () => {
    const { container } = at('/cases/case-0', <CasePage />, '/cases/:key');
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('RunDetailPage (D-5)', () => {
  beforeEach(() => {
    useRunMock.mockReturnValue({
      data: {
        run: {
          runId: 'baseline',
          label: 'nightly',
          reevaluationOf: null,
          traces: 10,
          evaluated: 10,
          passed: 8,
          agentNames: ['support-bot'],
          engineVersions: ['0.13.0'],
          rulesetHashes: ['3f2a91c0aa'],
          startedAt: '2026-09-01T00:00:00Z',
          lastActivityAt: '2026-09-01T00:10:00Z',
        },
        results: [
          { evalId: 'e1', traceId: 't1', caseKey: 'case-0', agentName: 'support-bot', passed: false, failedRules: ['min_output_length'], engineVersion: '0.13.0', rulesetHash: '3f2a91c0aa', configHash: '9b', createdAt: '2026-09-01T00:00:00Z' },
          { evalId: 'e2', traceId: 't2', caseKey: 'case-1', agentName: 'support-bot', passed: true, failedRules: [], engineVersion: '0.13.0', rulesetHash: '3f2a91c0aa', configHash: '9b', createdAt: '2026-09-01T00:01:00Z' },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
      rateLimitedUntil: null,
    });
  });

  it('the run: its counts, its label, and a link per case', () => {
    const { container } = at('/runs/baseline', <RunDetailPage />, '/runs/:id');
    expect(container.querySelector('[data-run-detail="baseline"]')).not.toBeNull();
    expect(container.querySelector('[data-run-passed]')?.textContent).toBe('8 of 10 passed');
    expect(container.textContent).toContain('nightly');
    expect(container.querySelector('[data-case-link="case-0"]')?.getAttribute('href')).toBe('/cases/case-0');
    expect(container.textContent).toContain('min_output_length');
  });

  it('has no axe violations', async () => {
    const { container } = at('/runs/baseline', <RunDetailPage />, '/runs/:id');
    expect((await axe(container)).violations).toEqual([]);
  });
});
