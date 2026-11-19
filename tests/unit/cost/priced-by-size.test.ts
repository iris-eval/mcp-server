/*
 * A request priced by its size: Claude Haiku 5.5 over 100,000 prompt tokens,
 * and OpenAI's models from GPT-5.4 over 272,000 input tokens, cost more for
 * the whole request (each provider's pricing page), and a request's size
 * counts its cache reads and writes.
 *
 * Every number here is worked by hand from the built-in table:
 * claude-haiku-5-5 is $0.10 in / $0.50 out per 1M tokens and $0.01 a cache
 * read, and over the line $0.50 / $2.50 and $0.05; gpt-6.2-sol is $2 / $10
 * with a $2.50 cache write, and over the line $4 / $15.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { estimateCostUsd, findPricing, ratesFor } from '../../../src/eval/llm-judge/pricing.js';
import { estimateCost } from '../../../src/cost-estimator.js';
import { estimateTraceCost } from '../../../src/cost/trace-cost.js';
import { setPricingSettings } from '../../../src/cost/model-lookup.js';
import type { CostEstimate, Span, Trace } from '../../../src/types/trace.js';

afterEach(() => setPricingSettings(undefined));

function estimatedOf(e: CostEstimate): Extract<CostEstimate, { status: 'estimated' }> {
  if (e.status !== 'estimated') throw new Error(`expected an estimate, got ${e.status}: ${e.message}`);
  return e;
}

const base = (extra: Partial<Trace> = {}): Trace => ({ trace_id: 't1', agent_name: 'bot', timestamp: '2026-11-18T10:00:00.000Z', ...extra });

const span = (id: string, attributes: Record<string, unknown>, parent?: string): Span => ({
  span_id: id,
  trace_id: 't1',
  name: id,
  kind: 'LLM',
  status_code: 'OK',
  start_time: '2026-11-18T10:00:00.000Z',
  ...(parent ? { parent_span_id: parent } : {}),
  attributes,
});

const call = (id: string, model: string, input: number, output: number, extra: Record<string, unknown> = {}): Span =>
  span(id, { 'gen_ai.request.model': model, 'gen_ai.usage.input_tokens': input, 'gen_ai.usage.output_tokens': output, ...extra });

const LONG_HAIKU = "claude-haiku-5-5: a call over 100,000 input tokens is priced at the provider's rates for such a request, every token of it.";
const totalNote = (counted: string): string =>
  `claude-haiku-5-5: priced at the rates of a request of up to 100,000 input tokens. The ${counted} counted are a total over calls, which cannot say whether a call was over that size; such a call costs more, so the estimate may be low.`;

describe('one request: its size picks its rates', () => {
  it('the judge prices a request at the line at the base rates, and one over it at the higher rates, every token', () => {
    // 100,000 × 0.10 + 1,000 × 0.50 = $0.0105; 200,000 × 0.50 + 1,000 × 2.50 = $0.1025
    expect(estimateCostUsd('claude-haiku-5-5', 100_000, 1_000)).toBe(0.0105);
    expect(estimateCostUsd('claude-haiku-5-5', 200_000, 1_000)).toBe(0.1025);
    // 272,000 × 2 + 1,000 × 10 = $0.554; 300,000 × 4 + 1,000 × 15 = $1.215
    expect(estimateCostUsd('gpt-6.2-sol', 272_000, 1_000)).toBe(0.554);
    expect(estimateCostUsd('gpt-6.2-sol', 300_000, 1_000)).toBe(1.215);
    // A model with one rate: 300,000 × 0.75 + 1,000 × 4.50 = $0.2295
    expect(estimateCostUsd('gpt-5.4-mini', 300_000, 1_000)).toBe(0.2295);
  });

  it('the line is the last size at the base rates', () => {
    const haiku = findPricing('claude-haiku-5-5')!;
    expect(ratesFor(haiku, 100_000).inputUsdPer1M).toBe(0.1);
    expect(ratesFor(haiku, 100_001).inputUsdPer1M).toBe(0.5);
    const sol = findPricing('gpt-6.2-sol')!;
    expect(ratesFor(sol, 272_000).outputUsdPer1M).toBe(10);
    expect(ratesFor(sol, 272_001).outputUsdPer1M).toBe(15);
  });

  it("the cost estimator's single call picks its rates the same way", () => {
    expect(estimateCost({ provider: 'anthropic', model: 'claude-haiku-5-5', tokensIn: 200_000, tokensOut: 1_000 })?.totalUsd).toBeCloseTo(0.1025, 10);
    expect(estimateCost({ provider: 'anthropic', model: 'claude-haiku-5-5', tokensIn: 100_000, tokensOut: 1_000 })?.totalUsd).toBeCloseTo(0.0105, 10);
  });
});

describe("a trace's call on a span is priced by its own size", () => {
  it('a call over the line: every token at the higher rates, the rates it was priced at, and a note', () => {
    const e = estimatedOf(estimateTraceCost(base({ spans: [call('c1', 'claude-haiku-5-5', 200_000, 1_000)] })).estimate);
    expect(e.calls).toEqual([expect.objectContaining({ priced_as: 'claude-haiku-5-5', prompt_tokens: 200_000, input_usd_per_1m: 0.5, output_usd_per_1m: 2.5, cost_usd: 0.1025 })]);
    expect(e.notes).toEqual([LONG_HAIKU]);
  });

  it('its cache reads count toward its size, and are priced at the higher cache rate', () => {
    // 200,000 in, 150,000 of them cache reads: 50,000 × 0.50 + 150,000 × 0.05 + 1,000 × 2.50 = $0.035
    const e = estimatedOf(estimateTraceCost(base({ spans: [call('c1', 'claude-haiku-5-5', 200_000, 1_000, { 'gen_ai.usage.cache_read.input_tokens': 150_000 })] })).estimate);
    expect(e.calls[0]).toMatchObject({ cache_read_tokens: 150_000, cache_read_usd_per_1m: 0.05, cost_usd: 0.035 });
  });

  it('cached counts beside a small input carry it over the line: 10,000 in and 95,000 read is a request of 105,000', () => {
    // 10,000 × 0.50 + 95,000 × 0.05 + 1,000 × 2.50 = $0.01225
    const e = estimatedOf(estimateTraceCost(base({ spans: [call('c1', 'claude-haiku-5-5', 10_000, 1_000, { 'gen_ai.usage.cache_read.input_tokens': 95_000 })] })).estimate);
    expect(e.calls[0]).toMatchObject({ prompt_tokens: 105_000, input_usd_per_1m: 0.5, cost_usd: 0.01225 });
    expect(e.notes).toContain(LONG_HAIKU);
  });

  it('a call within the line: the base rates, and nothing said', () => {
    // 90,000 × 0.10 + 1,000 × 0.50 = $0.0095
    const e = estimatedOf(estimateTraceCost(base({ spans: [call('c1', 'claude-haiku-5-5', 90_000, 1_000)] })).estimate);
    expect(e.calls[0]).toMatchObject({ input_usd_per_1m: 0.1, cost_usd: 0.0095 });
    expect(e.notes).toBeUndefined();
  });

  it("OpenAI's 30-minute cache write from GPT-5.6 is priced at 1.25 times the input", () => {
    // 20,000 in, 10,000 of them written: 10,000 × 2 + 10,000 × 2.50 = $0.045
    const e = estimatedOf(estimateTraceCost(base({ spans: [call('c1', 'gpt-6.2-sol', 20_000, 0, { 'gen_ai.usage.cache_creation.input_tokens': 10_000 })] })).estimate);
    expect(e.calls[0]).toMatchObject({ cache_write_usd_per_1m: 2.5, cost_usd: 0.045 });
  });
});

describe('a total cannot say how large each call was', () => {
  it('a trace of one model with a call over the line is priced call by call, not by its token_usage', () => {
    // 200,000 × 0.50 + 1,000 × 2.50 = $0.1025, and 10,000 × 0.10 + 1,000 × 0.50 = $0.0015
    const e = estimatedOf(
      estimateTraceCost(base({ token_usage: { prompt_tokens: 210_000, completion_tokens: 2_000 }, spans: [call('c1', 'claude-haiku-5-5', 200_000, 1_000), call('c2', 'claude-haiku-5-5', 10_000, 1_000)] })).estimate,
    );
    expect(e.basis).toBe('calls');
    expect(e.calls.map((c) => c.cost_usd)).toEqual([0.1025, 0.0015]);
  });

  it('a total whose calls account for all of it, none over the line, is priced by its token_usage at the base rates, and nothing is said', () => {
    // 180,000 × 0.10 + 2,000 × 0.50 = $0.019
    const e = estimatedOf(
      estimateTraceCost(base({ token_usage: { prompt_tokens: 180_000, completion_tokens: 2_000 }, spans: [call('c1', 'claude-haiku-5-5', 90_000, 1_000), call('c2', 'claude-haiku-5-5', 90_000, 1_000)] })).estimate,
    );
    expect(e.basis).toBe('token_usage');
    expect(e.calls[0].cost_usd).toBe(0.019);
    expect(e.notes).toBeUndefined();
  });

  it('a total larger than its recorded calls may hold a call that was over the line: the base rates, and it says so', () => {
    // 250,000 × 0.10 + 2,000 × 0.50 = $0.026
    const e = estimatedOf(
      estimateTraceCost(base({ token_usage: { prompt_tokens: 250_000, completion_tokens: 2_000 }, spans: [call('c1', 'claude-haiku-5-5', 90_000, 1_000), call('c2', 'claude-haiku-5-5', 90_000, 1_000)] })).estimate,
    );
    expect(e.calls[0].cost_usd).toBe(0.026);
    expect(e.notes).toEqual([totalNote('250,000')]);
  });

  it('token_usage alone, over the line: the base rates, and it says the estimate may be low', () => {
    // 300,000 × 0.10 + 1,000 × 0.50 = $0.0305
    const e = estimatedOf(estimateTraceCost(base({ token_usage: { prompt_tokens: 300_000, completion_tokens: 1_000 }, metadata: { model: 'claude-haiku-5-5' } })).estimate);
    expect(e.calls[0]).toMatchObject({ input_usd_per_1m: 0.1, cost_usd: 0.0305 });
    expect(e.notes).toEqual([totalNote('300,000')]);
  });

  it('token_usage alone, within the line: nothing said', () => {
    const e = estimatedOf(estimateTraceCost(base({ token_usage: { prompt_tokens: 100_000, completion_tokens: 1_000 }, metadata: { model: 'claude-haiku-5-5' } })).estimate);
    expect(e.notes).toBeUndefined();
  });

  it("a span carrying a whole run's usage, over the line: the base rates, and it says so", () => {
    const e = estimatedOf(
      estimateTraceCost(base({ spans: [span('run', { 'gen_ai.request.model': 'claude-haiku-5-5', 'gen_ai.aggregated_usage.input_tokens': 300_000, 'gen_ai.aggregated_usage.output_tokens': 1_000 })] })).estimate,
    );
    expect(e.calls[0]).toMatchObject({ input_usd_per_1m: 0.1, cost_usd: 0.0305 });
    expect(e.notes).toEqual([totalNote('300,000')]);
  });
});

describe('a price from config.json', () => {
  it('is one rate at every size: no higher rate and nothing said, even over the line', () => {
    setPricingSettings({ estimate: true, models: [{ model: 'claude-haiku-5-5', inputUsdPer1M: 0.1, outputUsdPer1M: 0.5, cacheReadUsdPer1M: 0.01 }] });
    // 200,000 × 0.10 + 1,000 × 0.50 = $0.0205
    const e = estimatedOf(estimateTraceCost(base({ spans: [call('c1', 'claude-haiku-5-5', 200_000, 1_000)] })).estimate);
    expect(e.calls[0]).toMatchObject({ price_source: 'config', input_usd_per_1m: 0.1, cost_usd: 0.0205 });
    expect(e.notes).toBeUndefined();
  });
});
