/*
 * A cost, and whether the trace reported it or Iris estimated it.
 *
 * Since 0.20.0 a trace that reports no cost is stored with one priced from
 * its token counts at list price (src/cost/trace-cost.ts on the server). The
 * number is shown like any other, followed by "est." whose tooltip names the
 * tokens, the model it was priced as and the date of the prices — an
 * estimate must never read as a bill.
 */
import type { CostEstimate, CostSource } from '../../api/types';
import { formatCost } from '../../utils/formatters';
import { Tooltip } from './Tooltip';

const NOT_APPLIED = 'Batch discounts and negotiated rates are not applied.';

/** The sentence the "est." marker's tooltip carries. */
export function estimateTooltip(estimate?: CostEstimate): string {
  if (!estimate || estimate.status !== 'estimated' || estimate.calls.length === 0) {
    return `Estimated by Iris from the trace's token counts at list price; the trace reported no cost. ${NOT_APPLIED}`;
  }
  const input = estimate.calls.reduce((n, c) => n + c.prompt_tokens, 0);
  const output = estimate.calls.reduce((n, c) => n + c.completion_tokens, 0);
  const cached = estimate.calls.reduce((n, c) => n + (c.cache_read_tokens ?? 0) + (c.cache_creation_tokens ?? 0), 0);
  const models = [...new Set(estimate.calls.map((c) => c.priced_as))].join(', ');
  const dates = [...new Set(estimate.calls.map((c) => c.price_as_of).filter((d): d is string => d !== null))];
  const table = estimate.calls.some((c) => c.price_source === 'config') ? 'prices in config.json' : 'list price';
  const asOf = dates.length > 0 ? ` as of ${dates.join(' and ')}` : '';
  const cachedText = cached > 0 ? ` (${cached.toLocaleString('en-US')} of them cached, at cache prices)` : '';
  const notes = estimate.notes && estimate.notes.length > 0 ? ` ${estimate.notes.join(' ')}` : '';
  return `Estimated by Iris: ${input.toLocaleString('en-US')} input${cachedText} and ${output.toLocaleString('en-US')} output tokens at ${models} ${table}${asOf}. The trace reported no cost. ${NOT_APPLIED}${notes}`;
}

/** The "est." marker, focusable so its tooltip is reachable from the keyboard. */
export function EstimatedMark({ estimate }: { estimate?: CostEstimate }) {
  return (
    <Tooltip content={estimateTooltip(estimate)}>
      <span
        tabIndex={0}
        data-cost-estimated=""
        aria-label="estimated"
        style={{ marginLeft: 'var(--space-1)', color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)', fontFamily: 'inherit' }}
      >
        est.
      </span>
    </Tooltip>
  );
}

export function CostDisplay({ value, source, estimate }: { value: number; source?: CostSource; estimate?: CostEstimate }) {
  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-sm)', whiteSpace: 'nowrap' }}>
      {formatCost(value)}
      {source === 'estimated' && <EstimatedMark estimate={estimate} />}
    </span>
  );
}
