/*
 * Recurring issues: fires grouped by what the rule found, with
 * a count, the agents, the labels so far, and a way in — one trace that
 * carries the fire. Nothing when there are none.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { axe } from 'jest-axe';
import type { IssuesResponse } from '../../../src/api/types';

const useIssuesMock = vi.fn();
vi.mock('../../../src/api/hooks', () => ({
  useIssues: (...args: unknown[]) => useIssuesMock(...args),
  CADENCE: { FAST: 3000, NORMAL: 10000, SLOW: 30000 },
}));

import { IssuesList } from '../../../src/components/dashboard/IssuesList';

const issues: IssuesResponse = {
  issues: [
    { key: '3f9a1c0b7e2d', ruleName: 'no_stub_output', signature: 'pattern:marker TODO', count: 10, agents: ['support-bot', 'writer'], firstSeen: '2026-09-19T10:00:00Z', lastSeen: new Date(Date.now() - 3 * 60_000).toISOString(), exampleEvalIds: ['eval_1', 'eval_2'], exampleTraceIds: [null, 'trc_2'], labelled: { right: 1, wrong: 3 } },
    { key: 'a1b2c3d4e5f6', ruleName: 'no_tool_loop', signature: 'tool:search:called 6 times in a row', count: 2, agents: [], firstSeen: '2026-09-19T10:00:00Z', lastSeen: '2026-09-19T10:00:00Z', exampleEvalIds: ['eval_9'], exampleTraceIds: [null], labelled: { right: 0, wrong: 0 } },
  ],
  window: 2000,
};

const query = <T,>(data: T | null) => ({ data, loading: false, error: null, refetch: vi.fn(), rateLimitedUntil: null });

describe('IssuesList (D-8)', () => {
  beforeEach(() => {
    useIssuesMock.mockReturnValue(query(issues));
  });

  it('one row per issue: rule, signature, count, agents, labels, and a link to a trace that carries the fire', () => {
    const { container } = render(<MemoryRouter><IssuesList /></MemoryRouter>);
    expect(useIssuesMock).toHaveBeenCalledWith({ limit: '20' });
    expect([...container.querySelectorAll('[data-issue-rule]')].map((e) => e.textContent)).toEqual(['no_stub_output', 'no_tool_loop']);
    expect(container.querySelector('[data-issue-signature="3f9a1c0b7e2d"]')?.textContent).toBe('pattern:marker TODO');
    expect(container.querySelector('[data-issue-count="3f9a1c0b7e2d"]')?.textContent).toBe('10');
    expect(container.querySelector('[data-issue-labelled="3f9a1c0b7e2d"]')?.textContent).toBe('1 right · 3 wrong');
    expect(container.querySelector('[data-issue-labelled="a1b2c3d4e5f6"]')?.textContent).toBe('—');
    expect(container.textContent).toContain('support-bot, writer');
    // The first example with a stored trace is the way in; an issue with none has no link.
    expect(container.querySelector('[data-issue-open="3f9a1c0b7e2d"]')?.getAttribute('href')).toBe('/traces/trc_2');
    expect(container.querySelector('[data-issue-open="a1b2c3d4e5f6"]')).toBeNull();
    expect(container.textContent).toContain('over your last 2000 evaluations');
  });

  it('renders nothing when there are no issues', () => {
    useIssuesMock.mockReturnValue(query({ issues: [], window: 2000 }));
    const { container } = render(<MemoryRouter><IssuesList /></MemoryRouter>);
    expect(container.querySelector('[data-issues]')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(<MemoryRouter><IssuesList /></MemoryRouter>);
    expect((await axe(container)).violations).toEqual([]);
  });
});
