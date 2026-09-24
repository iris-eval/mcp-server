/*
 * The local-precision panel: your labels per rule, the local
 * precision with its interval, whether it is in force, the published number
 * beside it, the estimated prior and what to label next — every number from
 * /labels/stats, nothing typed here.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { axe } from 'jest-axe';
import type { LabelStats } from '../../../src/api/types';

const useLabelStatsMock = vi.fn();
vi.mock('../../../src/api/hooks', () => ({
  useLabelStats: (...args: unknown[]) => useLabelStatsMock(...args),
  CADENCE: { FAST: 3000, NORMAL: 10000, SLOW: 30000 },
}));

import { LocalPrecisionPanel } from '../../../src/components/rules/LocalPrecisionPanel';

const stats: LabelStats = {
  rules: [
    { rule: 'no_stub_output', kind: 'inference', entersRisk: true, n: 20, right: 2, wrong: 18, precision: { point: 0.1, lo: 0.028, hi: 0.301 }, local: true, publishedPrecision: 0.96, fireRate: 0.3 },
    { rule: 'no_tool_loop', kind: 'detection', entersRisk: true, n: 4, right: 3, wrong: 1, precision: { point: 0.75, lo: 0.301, hi: 0.954 }, local: false, publishedPrecision: 1, fireRate: 0.12 },
    { rule: 'min_output_length', kind: 'measurement', entersRisk: false, n: 0, right: 0, wrong: 0, precision: null, local: false, publishedPrecision: 1, fireRate: 0.05 },
    { rule: 'no_pii', kind: 'detection', entersRisk: true, n: 0, right: 0, wrong: 0, precision: null, local: false, publishedPrecision: 0.71, fireRate: 0 },
  ],
  min: 20,
  window: 2000,
  estimatedPrior: { pi: 0.041, lo: 0.0105, hi: 0.113, ruleName: 'no_stub_output', fireRate: 0.3, sensitivity: 0.8 },
  suggestion: { ruleName: 'no_tool_loop', n: 4, halfwidthPoints: 33, fireRate: 0.12, sentence: 'label a no_tool_loop fire next: 4 labelled, ±33 points, fires on 12% of your traffic' },
  refreshedAt: '2026-09-20T18:00:00.000Z',
};

const query = <T,>(data: T | null) => ({ data, loading: false, error: null, refetch: vi.fn(), rateLimitedUntil: null });

describe('LocalPrecisionPanel', () => {
  beforeEach(() => {
    useLabelStatsMock.mockReturnValue(query(stats));
  });

  it('lists the rules you labelled or that fire, most labelled first, and leaves out a rule with neither', () => {
    const { container } = render(<MemoryRouter><LocalPrecisionPanel /></MemoryRouter>);
    const names = [...container.querySelectorAll('[data-label-rule]')].map((e) => e.textContent);
    expect(names).toEqual(['no_stub_output', 'no_tool_loop', 'min_output_length']);
    expect(container.querySelector('[data-label-summary]')?.textContent).toBe('24 labels on 2 rules · in force on 1');
  });

  it('shows the local precision with its interval and n, whether it is in force, and the distance to the floor', () => {
    const { container } = render(<MemoryRouter><LocalPrecisionPanel /></MemoryRouter>);
    expect(container.querySelector('[data-local-precision="no_stub_output"]')?.textContent).toBe('0.10 [0.03, 0.30] · n = 20');
    expect(container.querySelector('[data-local-in-force="no_stub_output"]')?.textContent).toBe('yes · in the risk');
    expect(container.querySelector('[data-local-precision="no_tool_loop"]')?.textContent).toBe('0.75 [0.30, 0.95] · n = 4');
    expect(container.querySelector('[data-local-in-force="no_tool_loop"]')).toBeNull();
    expect(container.textContent).toContain('16 more');
    expect(container.querySelector('[data-local-precision="min_output_length"]')?.textContent).toBe('no labels yet');
    expect(container.querySelector('[data-label-count="no_stub_output"]')?.textContent).toBe('2 right · 18 wrong');
  });

  it('says the estimated prior and which rule to label next, in the server’s words', () => {
    const { container } = render(<MemoryRouter><LocalPrecisionPanel /></MemoryRouter>);
    const prior = container.querySelector('[data-estimated-prior]')!;
    expect(prior.getAttribute('data-estimated-prior')).toBe('0.041');
    expect(prior.textContent).toContain('0.04 [0.01, 0.11]');
    expect(prior.textContent).toContain('from no_stub_output (fires on 30% of your traffic)');
    expect(container.querySelector('[data-sampling-suggestion="no_tool_loop"]')?.textContent).toBe('Next: label a no_tool_loop fire next: 4 labelled, ±33 points, fires on 12% of your traffic.');
  });

  it('with nothing labelled and nothing firing, says so and invents no number', () => {
    useLabelStatsMock.mockReturnValue(query({ ...stats, rules: stats.rules.map((r) => ({ ...r, n: 0, right: 0, wrong: 0, precision: null, local: false, fireRate: 0 })), estimatedPrior: null, suggestion: null }));
    const { container } = render(<MemoryRouter><LocalPrecisionPanel /></MemoryRouter>);
    expect(container.querySelector('[data-label-summary]')?.textContent).toBe('0 labels on 0 rules · in force on 0');
    expect(container.querySelector('[data-estimated-prior]')).toBeNull();
    expect(container.querySelector('[data-sampling-suggestion]')).toBeNull();
    expect(container.textContent).toContain('No labels yet, and no rule has fired on your recent traffic.');
  });

  it('has no axe violations', async () => {
    const { container } = render(<MemoryRouter><LocalPrecisionPanel /></MemoryRouter>);
    expect((await axe(container)).violations).toEqual([]);
  });
});
