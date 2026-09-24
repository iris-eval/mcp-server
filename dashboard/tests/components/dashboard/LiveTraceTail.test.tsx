/*
 * The live trace tail survives a trace that recorded no cost.
 *
 * The API serializes a missing cost as `cost_usd: null`, not undefined —
 * the shape every REST or CLI ingest without a price produces. The tail
 * guarded only `undefined`, so one such trace threw `null.toFixed` and the
 * whole Stream view showed the error boundary; the labels state spec's own
 * stored trace found it on the Firefox half of CI.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { axe } from 'jest-axe';
import type { Trace } from '../../../src/api/types';

const useTracesMock = vi.fn();
vi.mock('../../../src/api/hooks', () => ({
  useTraces: (...args: unknown[]) => useTracesMock(...args),
  CADENCE: { FAST: 3000, NORMAL: 10000, SLOW: 30000 },
}));

import { LiveTraceTail } from '../../../src/components/dashboard/charts/LiveTraceTail';

function trace(id: string, extra: Partial<Trace> = {}): Trace {
  return {
    trace_id: id,
    agent_name: `agent-${id}`,
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    input: 'Summarise the release notes.',
    output: 'TODO: write the summary.',
    ...extra,
  } as Trace;
}

const query = (traces: Trace[]) => ({ data: { traces, total: traces.length, limit: 20, offset: 0 }, loading: false, error: null, refetch: vi.fn(), rateLimitedUntil: null });

describe('LiveTraceTail (D-9): a trace with no cost', () => {
  beforeEach(() => {
    useTracesMock.mockReset();
  });

  it('renders "—" for a null cost — the shape the server actually serializes — and the priced rows beside it', () => {
    useTracesMock.mockReturnValue(query([trace('t-null', { cost_usd: null as unknown as number }), trace('t-priced', { cost_usd: 0.0123 })]));
    const { container } = render(<MemoryRouter><LiveTraceTail /></MemoryRouter>);
    expect(container.querySelector('[data-tail-cost="t-null"]')?.textContent).toBe('—');
    expect(container.querySelector('[data-tail-cost="t-priced"]')?.textContent).toBe('$0.0123');
  });

  it('renders "—" for an absent cost too', () => {
    useTracesMock.mockReturnValue(query([trace('t-none')]));
    const { container } = render(<MemoryRouter><LiveTraceTail /></MemoryRouter>);
    expect(container.querySelector('[data-tail-cost="t-none"]')?.textContent).toBe('—');
  });

  it('has no axe violations', async () => {
    useTracesMock.mockReturnValue(query([trace('t-null', { cost_usd: null as unknown as number })]));
    const { container } = render(<MemoryRouter><LiveTraceTail /></MemoryRouter>);
    expect((await axe(container)).violations).toEqual([]);
  });
});
