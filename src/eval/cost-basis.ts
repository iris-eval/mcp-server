/*
 * What a cost rule says about where its number came from.
 *
 * A cost Iris estimated from token counts × list price is acted on like a
 * reported one — a budget or an anomaly is the same question either way —
 * but a reader must never mistake one for the other: an estimate does not
 * know a cache discount, a batch price or a negotiated rate. So every cost
 * rule's message ends with this note when the cost was estimated, and its
 * cost evidence carries `costSource: "estimated"`.
 */
import type { EvalContext } from '../types/eval.js';
import type { CostEstimate, CostSource, Trace } from '../types/trace.js';

/** The cost fields of an eval context, read from a stored or just-settled trace. */
export function costContextOf(trace: Pick<Trace, 'cost_usd' | 'cost_source' | 'cost_estimate'>): { costUsd?: number; costSource?: CostSource; costEstimate?: CostEstimate } {
  if (typeof trace.cost_usd !== 'number') return {};
  return {
    costUsd: trace.cost_usd,
    ...(trace.cost_source !== undefined ? { costSource: trace.cost_source } : {}),
    ...(trace.cost_source === 'estimated' && trace.cost_estimate !== undefined ? { costEstimate: trace.cost_estimate } : {}),
  };
}

function priceDates(estimate: Extract<CostEstimate, { status: 'estimated' }>): string {
  const dates = [...new Set(estimate.calls.map((c) => (c.price_as_of !== null ? c.price_as_of : 'undated')))];
  const fromConfig = estimate.calls.some((c) => c.price_source === 'config');
  const when = dates.filter((d) => d !== 'undated');
  const as = when.length > 0 ? ` as of ${when.join(' and ')}` : '';
  return `${fromConfig ? 'the list price in config.json pricing.models' : 'list price'}${as}`;
}

/**
 * The sentence a cost rule appends to its message when the cost was
 * estimated, starting with a space; empty for a reported cost.
 */
export function costBasisNote(context: Pick<EvalContext, 'costSource' | 'costEstimate'>): string {
  if (context.costSource !== 'estimated') return '';
  const estimate = context.costEstimate;
  if (estimate === undefined || estimate.status !== 'estimated') return ' (estimated by Iris from token counts × list price; the trace reported no cost)';
  const tokens = estimate.calls.reduce(
    (n, c) => ({ in: n.in + c.prompt_tokens, out: n.out + c.completion_tokens, cached: n.cached + (c.cache_read_tokens ?? 0) + (c.cache_creation_tokens ?? 0) }),
    { in: 0, out: 0, cached: 0 },
  );
  const models = [...new Set(estimate.calls.map((c) => c.priced_as))].join(', ');
  const n = (x: number) => x.toLocaleString('en-US');
  const cached = tokens.cached > 0 ? ` (${n(tokens.cached)} of them cached)` : '';
  return ` (estimated by Iris: ${n(tokens.in)} input${cached} and ${n(tokens.out)} output tokens at ${models} ${priceDates(estimate)}; the trace reported no cost)`;
}

/** The evidence field that says so, on a cost stat: present when the cost was estimated (absent means the cost was reported). */
export function costSourceEvidence(context: Pick<EvalContext, 'costSource'>): { costSource?: 'estimated' } {
  return context.costSource === 'estimated' ? { costSource: 'estimated' } : {};
}
