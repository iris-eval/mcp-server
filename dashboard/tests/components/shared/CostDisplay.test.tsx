import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { axe } from 'jest-axe';
import { CostDisplay, estimateTooltip } from '../../../src/components/shared/CostDisplay';
import { TraceTable } from '../../../src/components/traces/TraceTable';
import type { CostEstimate, CostEstimateCall, Trace } from '../../../src/api/types';

/* The call the server stores for 150,000 input and 10,000 output tokens of gpt-4o-mini (src/cost/trace-cost.ts). */
const CALL: CostEstimateCall = {
  model: 'gpt-4o-mini-2024-07-18',
  priced_as: 'gpt-4o-mini',
  prompt_tokens: 150_000,
  completion_tokens: 10_000,
  input_usd_per_1m: 0.15,
  output_usd_per_1m: 0.6,
  cost_usd: 0.0285,
  price_source: 'iris',
  price_as_of: '2026-09-28',
};
const ESTIMATE: CostEstimate = { status: 'estimated', basis: 'token_usage', calls: [CALL] };

describe('CostDisplay', () => {
  it('formats sub-dollar values to 4 decimal places', () => {
    render(<CostDisplay value={0.0123} />);
    expect(screen.getByText('$0.0123')).toBeInTheDocument();
  });

  it('a reported cost carries no marker', () => {
    const { container } = render(<CostDisplay value={0.0123} source="reported" />);
    expect(container.querySelector('[data-cost-estimated]')).toBeNull();
    expect(container.textContent).toBe('$0.0123');
  });

  it('an estimated cost is marked est., and the tooltip names the tokens, the model and the date of the prices', async () => {
    vi.useFakeTimers();
    try {
      render(<CostDisplay value={0.0285} source="estimated" estimate={ESTIMATE} />);
      expect(screen.getByText('$0.0285')).toBeInTheDocument();
      const mark = screen.getByText('est.');
      act(() => {
        fireEvent.focus(mark);
      });
      const tip = screen.getByRole('tooltip');
      expect(tip.textContent).toBe(
        'Estimated by Iris: 150,000 input and 10,000 output tokens at gpt-4o-mini list price as of 2026-09-28. The trace reported no cost. Batch discounts and negotiated rates are not applied.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('cached tokens are named as priced at cache prices, and the estimate\u2019s notes are carried', () => {
    const cached: CostEstimate = {
      status: 'estimated',
      basis: 'token_usage',
      calls: [{ ...CALL, cache_read_tokens: 100_000, cache_creation_tokens: 0, cache_read_usd_per_1m: 0.075, cache_write_usd_per_1m: 0.15, cost_usd: 0.021 }],
      notes: ['prod: 5 cache-read tokens are priced at the input price.'],
    };
    expect(estimateTooltip(cached)).toBe(
      'Estimated by Iris: 150,000 input (100,000 of them cached, at cache prices) and 10,000 output tokens at gpt-4o-mini list price as of 2026-09-28. The trace reported no cost. Batch discounts and negotiated rates are not applied. prod: 5 cache-read tokens are priced at the input price.',
    );
  });

  it('prices from config.json say so, and an undated config names no date', () => {
    const fromConfig: CostEstimate = { status: 'estimated', basis: 'token_usage', calls: [{ ...CALL, priced_as: 'my-deployment', price_source: 'config', price_as_of: null }] };
    expect(estimateTooltip(fromConfig)).toContain('at my-deployment prices in config.json. The trace reported no cost.');
  });

  it('the marker has no axe violations', async () => {
    const { container } = render(<CostDisplay value={0.0285} source="estimated" estimate={ESTIMATE} />);
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('the trace list marks estimated costs', () => {
  const base = { agent_name: 'bot', timestamp: '2026-09-28T10:00:00Z' };
  const traces: Trace[] = [
    { ...base, trace_id: 'reported-1', cost_usd: 0.0123, cost_source: 'reported' },
    { ...base, trace_id: 'estimated-1', cost_usd: 0.0285, cost_source: 'estimated', cost_estimate: ESTIMATE },
    { ...base, trace_id: 'unpriced-1', cost_estimate: { status: 'unpriced', reason: 'unknown_model', message: 'No cost: the model "llama-3" is not in Iris\'s pricing table.', models: ['llama-3'] } },
  ];

  it('only the estimated row carries est.; a trace with no cost shows a dash', () => {
    const { container } = render(
      <MemoryRouter>
        <TraceTable traces={traces} onSelect={() => {}} />
      </MemoryRouter>,
    );
    const rows = [...container.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(3);
    const marked = rows.map((r) => r.querySelector('[data-cost-estimated]') !== null);
    expect(marked).toEqual([false, true, false]);
    expect(rows[1].textContent).toContain('$0.0285est.');
    expect(rows[2].textContent).toContain('—');
  });
});
