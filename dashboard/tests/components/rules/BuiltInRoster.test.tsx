/*
 * The built-in roster (D-5): every shipped rule with its kind, mechanism,
 * question, criticality and published precision — or "no family".
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { axe } from 'jest-axe';
import type { BuiltInRuleMeta, CapabilitiesSummary } from '../../../src/api/types';

const useBuiltInRulesMock = vi.fn();
const useCapabilitiesMock = vi.fn();
vi.mock('../../../src/api/hooks', () => ({
  useBuiltInRules: (...args: unknown[]) => useBuiltInRulesMock(...args),
  useCapabilities: (...args: unknown[]) => useCapabilitiesMock(...args),
  CADENCE: { FAST: 3000, NORMAL: 10000, SLOW: 30000 },
}));

import { BuiltInRoster, fmtPrecision } from '../../../src/components/rules/BuiltInRoster';

const rules: BuiltInRuleMeta[] = [
  { name: 'no_pii', category: 'safety', description: 'PII', weight: 1, kind: 'detection', mechanism: 'pattern', question: 'safe_output', version: 3, critical: true, criticalSource: 'default' },
  { name: 'min_output_length', category: 'completeness', description: 'length', weight: 1, kind: 'measurement', mechanism: 'formula', question: 'complete', version: 1, critical: false, criticalSource: 'default' },
];

const capabilities: CapabilitiesSummary = {
  rules: [
    {
      name: 'no_pii',
      proof: {
        tp: 20, fp: 8, fn: 5, tn: 108, n: 141, precision: 0.714, recall: 0.8, f1: 0.755,
        ci95: { precision: [0.53, 0.85], recall: [0.6, 0.92], f1: [0.6, 0.86] },
        ppvAt: {}, corpusVersion: 'a4e0e6d77d07', release: '0.13.0', labelling: 'same-model',
      },
    },
    { name: 'min_output_length', proof: null },
  ],
};

const query = <T,>(data: T | null) => ({ data, loading: false, error: null, refetch: vi.fn(), rateLimitedUntil: null });

describe('BuiltInRoster (D-5)', () => {
  beforeEach(() => {
    useBuiltInRulesMock.mockReturnValue(query(rules));
    useCapabilitiesMock.mockReturnValue(query(capabilities));
  });

  it('lists every rule, sorted, with its precision or "no family", and the corpus line', () => {
    const { container } = render(<MemoryRouter><BuiltInRoster /></MemoryRouter>);
    expect(container.querySelector('[data-roster-count]')?.getAttribute('data-roster-count')).toBe('2');
    const names = [...container.querySelectorAll('[data-roster-rule]')].map((e) => e.textContent);
    expect(names).toEqual(['min_output_length', 'no_pii']);
    expect(container.querySelector('[data-roster-precision="no_pii"]')?.textContent).toBe('0.71 [0.53, 0.85] · n = 141');
    expect(container.querySelector('[data-roster-precision="min_output_length"]')?.textContent).toBe('no family');
    expect(container.querySelector('[data-roster-critical="default"]')?.textContent).toBe('yes · default');
    expect(container.textContent).toContain('1 with a published error rate');
    expect(container.textContent).toContain('corpus a4e0e6d77d07');
  });

  it('without capabilities every row says no family rather than inventing a number', () => {
    useCapabilitiesMock.mockReturnValue(query(null));
    const { container } = render(<MemoryRouter><BuiltInRoster /></MemoryRouter>);
    expect(container.querySelector('[data-roster-precision="no_pii"]')?.textContent).toBe('no family');
  });

  it('fmtPrecision', () => {
    expect(fmtPrecision(null)).toBe('no family');
    expect(fmtPrecision(capabilities.rules![0].proof)).toBe('0.71 [0.53, 0.85] · n = 141');
  });

  it('has no axe violations', async () => {
    const { container } = render(<MemoryRouter><BuiltInRoster /></MemoryRouter>);
    expect((await axe(container)).violations).toEqual([]);
  });
});
