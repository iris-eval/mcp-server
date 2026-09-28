/*
 * A trace's cost: reported, estimated, or none with the reason (#702).
 *
 * Every number here is worked by hand from the built-in table: gpt-4o-mini
 * is $0.15 in / $0.60 out per 1M tokens, gpt-4o $2.50 / $10, claude-sonnet-5
 * $2 / $10.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { estimateTraceCost, resolveTraceCost, costFieldsOf } from '../../../src/cost/trace-cost.js';
import { setPricingSettings } from '../../../src/cost/model-lookup.js';
import type { Span, Trace } from '../../../src/types/trace.js';

afterEach(() => setPricingSettings(undefined));

const base = (extra: Partial<Trace> = {}): Trace => ({ trace_id: 't1', agent_name: 'bot', timestamp: '2026-09-28T10:00:00.000Z', ...extra });

const span = (id: string, attributes: Record<string, unknown>, parent?: string): Span => ({
  span_id: id,
  trace_id: 't1',
  name: id,
  kind: 'LLM',
  status_code: 'OK',
  start_time: '2026-09-28T10:00:00.000Z',
  ...(parent ? { parent_span_id: parent } : {}),
  attributes,
});

describe('a reported cost', () => {
  it('wins, is marked reported, and is never replaced by an estimate — even with tokens and a priced model', () => {
    const t = resolveTraceCost(base({ cost_usd: 0.5, token_usage: { prompt_tokens: 1_000_000, completion_tokens: 0 }, metadata: { model: 'gpt-4o' } }));
    expect(t.cost_usd).toBe(0.5);
    expect(t.cost_source).toBe('reported');
    expect(t.cost_estimate).toBeUndefined();
  });

  it('a reported 0 is a cost, not a missing one', () => {
    const t = resolveTraceCost(base({ cost_usd: 0, token_usage: { prompt_tokens: 10, completion_tokens: 10 }, metadata: { model: 'gpt-4o' } }));
    expect(t).toMatchObject({ cost_usd: 0, cost_source: 'reported' });
  });

  it('resolving twice changes nothing: the storage backstop sees a settled trace and leaves it', () => {
    const once = resolveTraceCost(base({ token_usage: { prompt_tokens: 150_000, completion_tokens: 10_000 }, metadata: { model: 'gpt-4o-mini' } }));
    expect(resolveTraceCost(once)).toBe(once);
  });
});

describe('an estimate from token_usage and metadata.model', () => {
  it('prices the gpt-4o-mini trace that motivated this: 150,000 in + 10,000 out = $0.0285', () => {
    const t = resolveTraceCost(base({ token_usage: { prompt_tokens: 150_000, completion_tokens: 10_000, total_tokens: 160_000 }, metadata: { model: 'gpt-4o-mini' } }));
    expect(t.cost_usd).toBe(0.0285);
    expect(t.cost_source).toBe('estimated');
    expect(t.cost_estimate).toEqual({
      status: 'estimated',
      basis: 'token_usage',
      calls: [{ model: 'gpt-4o-mini', priced_as: 'gpt-4o-mini', prompt_tokens: 150_000, completion_tokens: 10_000, input_usd_per_1m: 0.15, output_usd_per_1m: 0.6, cost_usd: 0.0285, price_source: 'iris', price_as_of: '2026-09-25' }],
    });
  });

  it('a dated snapshot and a provider prefix price as their row', () => {
    expect(estimateTraceCost(base({ token_usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }, metadata: { model: 'openai/gpt-4o-2024-11-20' } })).cost_usd).toBe(12.5);
  });

  it('needs both token counts: input and output are priced differently', () => {
    const { cost_usd, estimate } = estimateTraceCost(base({ token_usage: { total_tokens: 5000 }, metadata: { model: 'gpt-4o' } }));
    expect(cost_usd).toBeUndefined();
    expect(estimate).toMatchObject({ status: 'unpriced', reason: 'no_tokens' });
    expect((estimate as { message: string }).message).toMatch(/both prompt_tokens and completion_tokens/);
  });
});

describe('no estimate, and the reason', () => {
  it('an unknown model: null, never a guess, and the reason names the model and the way out', () => {
    const t = resolveTraceCost(base({ token_usage: { prompt_tokens: 100, completion_tokens: 100 }, metadata: { model: 'llama-3.1-70b' } }));
    expect(t.cost_usd).toBeUndefined();
    expect(t.cost_source).toBeUndefined();
    expect(t.cost_estimate).toEqual({
      status: 'unpriced',
      reason: 'unknown_model',
      models: ['llama-3.1-70b'],
      message: 'No cost: the model "llama-3.1-70b" is not in Iris\'s pricing table (as of 2026-09-25). Send cost_usd with the trace (or iris.cost_usd on a span), or price it under pricing.models in config.json.',
    });
    expect(costFieldsOf(t)).toEqual({ cost_usd: null, cost_estimate: t.cost_estimate });
  });

  it('tokens and no model', () => {
    expect(estimateTraceCost(base({ token_usage: { prompt_tokens: 1, completion_tokens: 1 } })).estimate).toMatchObject({ status: 'unpriced', reason: 'no_model' });
  });

  it('nothing at all', () => {
    expect(estimateTraceCost(base()).estimate).toMatchObject({ status: 'unpriced', reason: 'no_tokens', message: expect.stringMatching(/carries no token counts/) });
  });

  it('pricing.estimate false: nothing is estimated, and the reason says where it was turned off', () => {
    setPricingSettings({ estimate: false, models: [] });
    const t = resolveTraceCost(base({ token_usage: { prompt_tokens: 150_000, completion_tokens: 10_000 }, metadata: { model: 'gpt-4o-mini' } }));
    expect(t.cost_usd).toBeUndefined();
    expect(t.cost_estimate).toMatchObject({ status: 'unpriced', reason: 'disabled', message: expect.stringMatching(/pricing\.estimate is false in config\.json/) });
    // A reported cost is still reported.
    expect(resolveTraceCost(base({ cost_usd: 0.2 }))).toMatchObject({ cost_usd: 0.2, cost_source: 'reported' });
  });
});

describe('model calls on spans', () => {
  it('one model across the calls: the trace token_usage is priced at it (the numbers the trace shows are the numbers priced)', () => {
    const t = resolveTraceCost(
      base({
        token_usage: { prompt_tokens: 812, completion_tokens: 133, total_tokens: 945 },
        spans: [
          span('root', { 'gen_ai.aggregated_usage.input_tokens': 812, 'gen_ai.aggregated_usage.output_tokens': 133 }),
          span('c1', { 'gen_ai.request.model': 'gpt-4o', 'gen_ai.response.model': 'gpt-4o-2024-08-06', 'gen_ai.usage.input_tokens': 402, 'gen_ai.usage.output_tokens': 60 }, 'root'),
          span('c2', { 'gen_ai.request.model': 'gpt-4o', 'gen_ai.usage.input_tokens': 390, 'gen_ai.usage.output_tokens': 73 }, 'root'),
        ],
      }),
    );
    // 812 × 2.5 + 133 × 10 = 2030 + 1330 → $0.00336
    expect(t.cost_usd).toBe(0.00336);
    expect(t.cost_estimate).toMatchObject({ status: 'estimated', basis: 'token_usage', calls: [{ priced_as: 'gpt-4o', prompt_tokens: 812, completion_tokens: 133 }] });
  });

  it('two models: each call at its own price, summed — never the whole trace at the first model', () => {
    const t = resolveTraceCost(
      base({
        token_usage: { prompt_tokens: 20_000, completion_tokens: 2_000 },
        metadata: { model: 'gpt-4o' },
        spans: [
          span('plan', { 'gen_ai.request.model': 'gpt-4o', 'gen_ai.usage.input_tokens': 10_000, 'gen_ai.usage.output_tokens': 1_000 }),
          span('draft', { 'gen_ai.request.model': 'gpt-4o-mini', 'gen_ai.usage.input_tokens': 10_000, 'gen_ai.usage.output_tokens': 1_000 }),
        ],
      }),
    );
    // gpt-4o: 10,000 × 2.5 + 1,000 × 10 = $0.035; gpt-4o-mini: 10,000 × 0.15 + 1,000 × 0.6 = $0.0021
    expect(t.cost_usd).toBe(0.0371);
    expect(t.cost_estimate).toMatchObject({ status: 'estimated', basis: 'calls', calls: [{ priced_as: 'gpt-4o', cost_usd: 0.035 }, { priced_as: 'gpt-4o-mini', cost_usd: 0.0021 }] });
    // The whole trace at gpt-4o would have said $0.07.
  });

  it('a parent that repeats its children’s usage is counted once (the leaves are the calls)', () => {
    const { estimate } = estimateTraceCost(
      base({
        spans: [
          span('agent', { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.request.model': 'gpt-4o', 'gen_ai.usage.input_tokens': 2000, 'gen_ai.usage.output_tokens': 200 }),
          span('a', { 'gen_ai.request.model': 'gpt-4o', 'gen_ai.usage.input_tokens': 1000, 'gen_ai.usage.output_tokens': 100 }, 'agent'),
          span('b', { 'gen_ai.request.model': 'claude-sonnet-5', 'gen_ai.usage.input_tokens': 1000, 'gen_ai.usage.output_tokens': 100 }, 'agent'),
        ],
      }),
    );
    expect(estimate).toMatchObject({ basis: 'calls', calls: [{ prompt_tokens: 1000 }, { prompt_tokens: 1000 }] });
  });

  it('a call with no model of its own takes its nearest ancestor’s, then the trace’s', () => {
    const inherited = estimateTraceCost(base({ spans: [span('agent', { 'gen_ai.request.model': 'claude-sonnet-5' }), span('call', { 'gen_ai.usage.input_tokens': 1_000_000, 'gen_ai.usage.output_tokens': 0 }, 'agent')] }));
    expect(inherited.cost_usd).toBe(2);
    const fromTrace = estimateTraceCost(base({ metadata: { model: 'gpt-4o-mini' }, spans: [span('call', { 'gen_ai.usage.input_tokens': 1_000_000, 'gen_ai.usage.output_tokens': 0 })] }));
    expect(fromTrace.cost_usd).toBe(0.15);
  });

  it('the answering model is priced first; the requested one when the answer names no priced model', () => {
    // An Azure deployment name asked, the real model answered.
    const answered = estimateTraceCost(base({ spans: [span('c', { 'gen_ai.request.model': 'prod-gpt4o', 'gen_ai.response.model': 'gpt-4o-2024-11-20', 'gen_ai.usage.input_tokens': 1_000_000, 'gen_ai.usage.output_tokens': 0 })] }));
    expect(answered.estimate).toMatchObject({ calls: [{ model: 'gpt-4o-2024-11-20', priced_as: 'gpt-4o' }] });
    // A snapshot nobody has checked answered; the alias asked is what the provider prices.
    const asked = estimateTraceCost(base({ spans: [span('c', { 'gen_ai.request.model': 'gpt-4o-mini', 'gen_ai.response.model': 'gpt-4o-mini-2099-01-01', 'gen_ai.usage.input_tokens': 1_000_000, 'gen_ai.usage.output_tokens': 0 })] }));
    expect(asked.estimate).toMatchObject({ calls: [{ model: 'gpt-4o-mini', priced_as: 'gpt-4o-mini' }] });
  });

  it('one unpriced call leaves the whole trace unpriced — a partial sum would pass a budget it should fail', () => {
    const { cost_usd, estimate } = estimateTraceCost(
      base({
        spans: [
          span('a', { 'gen_ai.request.model': 'gpt-4o', 'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 10 }),
          span('b', { 'gen_ai.request.model': 'gemini-2.5-pro', 'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 10 }),
        ],
      }),
    );
    expect(cost_usd).toBeUndefined();
    expect(estimate).toMatchObject({ status: 'unpriced', reason: 'unknown_model', models: ['gemini-2.5-pro'] });
  });

  it('a call with tokens and no model anywhere is no_model', () => {
    expect(estimateTraceCost(base({ spans: [span('c', { 'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 10 })] })).estimate).toMatchObject({ reason: 'no_model' });
  });

  it('a parent cycle in hand-written spans cannot loop', () => {
    const { estimate } = estimateTraceCost(base({ spans: [span('a', { 'gen_ai.request.model': 'gpt-4o', 'gen_ai.usage.input_tokens': 1, 'gen_ai.usage.output_tokens': 1 }, 'b'), span('b', {}, 'a')] }));
    expect(estimate.status).toBe('estimated');
  });
});

describe('pricing.models from config.json', () => {
  it('prices a deployment name the built-in table does not know, and says the price came from the config', () => {
    setPricingSettings({ estimate: true, models: [{ model: 'my-deployment', inputUsdPer1M: 1, outputUsdPer1M: 2 }], asOf: '2026-09-01' });
    const t = resolveTraceCost(base({ token_usage: { prompt_tokens: 500_000, completion_tokens: 250_000 }, metadata: { model: 'my-deployment' } }));
    expect(t.cost_usd).toBe(1);
    expect(t.cost_estimate).toMatchObject({ calls: [{ price_source: 'config', price_as_of: '2026-09-01' }] });
  });
});
