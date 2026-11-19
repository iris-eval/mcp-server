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
import { estimateCostUsd, findPricing, INPUT_ESTIMATE_MARGIN, ratesFor, worstCaseRequestUsd } from '../../../src/eval/llm-judge/pricing.js';
import { estimateBatch, estimateCost } from '../../../src/cost-estimator.js';
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

  it('the cost estimator answers null for an id every object carries, as for any model the table does not price', () => {
    for (const model of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(estimateCost({ provider: 'openai', model, tokensIn: 1_000, tokensOut: 100 }), model).toBeNull();
    }
    expect(estimateBatch([{ provider: 'openai', model: 'gpt-4o-mini', tokensIn: 1_000, tokensOut: 100 }, { provider: 'openai', model: 'constructor', tokensIn: 1_000, tokensOut: 100 }])).toMatchObject({ estimatedCount: 1, unknownModelCount: 1 });
  });

  it('input a reply says was read from the cache or written to it, counted within the input, is priced at those rates', () => {
    // 50,000 in: 20,000 plain × 8 + 10,000 read × 0.40 + 20,000 written × 10, and 100 out × 40 = $0.368
    expect(estimateCostUsd('gpt-6.2-astra', 50_000, 100, { readTokens: 10_000, writeTokens: 20_000 })).toBe(0.368);
    // Over the line, at its rates: 200,000 plain × 16 + 100,000 written × 20 = $5.20
    expect(estimateCostUsd('gpt-6.2-astra', 300_000, 0, { writeTokens: 100_000 })).toBe(5.2);
    // Counts larger than the input are held to it: 1,000 in, all of it read, × 0.40 = $0.0004
    expect(estimateCostUsd('gpt-6.2-astra', 1_000, 0, { readTokens: 5_000, writeTokens: 5_000 })).toBe(0.0004);
    expect(estimateCostUsd('gpt-6.2-astra', 1_000, 0, {})).toBe(estimateCostUsd('gpt-6.2-astra', 1_000, 0));
  });

  it("a cost cap's worst case takes the higher rates wherever the input estimate, raised by the margin, is over the line", () => {
    expect(INPUT_ESTIMATE_MARGIN).toBe(1.3);
    // 76,923 × 1.3 is 99,999.9, at the line: 76,923 × 0.10 + 512 × 0.50 = $0.0079483 (to six places, 0.007948)
    expect(worstCaseRequestUsd('claude-haiku-5-5', 76_923, 512)).toBe(0.007948);
    // 76,924 × 1.3 is over it: 76,924 × 0.50 + 512 × 2.50 = $0.039742
    expect(worstCaseRequestUsd('claude-haiku-5-5', 76_924, 512)).toBe(0.039742);
    // A model with one rate prices its estimate as it is: 300,000 × 0.75 + 512 × 4.50 = $0.227304
    expect(worstCaseRequestUsd('gpt-5.4-mini', 300_000, 512)).toBe(0.227304);
    expect(worstCaseRequestUsd('not-a-model', 1_000, 512)).toBeNull();
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

  it("a call over the line has its cache writes priced at that size's write rates, the 1-hour ones at its 1-hour rate", () => {
    // 200,000 in, 50,000 written, 20,000 of them for an hour: 150,000 × 0.50 + 30,000 × 0.625 + 20,000 × 1 + 1,000 × 2.50 = $0.11625
    const e = estimatedOf(
      estimateTraceCost(base({ spans: [call('c1', 'claude-haiku-5-5', 200_000, 1_000, { 'gen_ai.usage.cache_creation.input_tokens': 50_000, 'iris.usage.cache_creation.ephemeral_1h_input_tokens': 20_000 })] })).estimate,
    );
    expect(e.calls[0]).toMatchObject({ cache_write_usd_per_1m: 0.625, cache_write_1h_usd_per_1m: 1, cost_usd: 0.11625 });
  });

  it('a call at the line itself is within it: a trace of one model is then priced by its token_usage', () => {
    const e = estimatedOf(estimateTraceCost(base({ token_usage: { prompt_tokens: 100_000, completion_tokens: 1_000 }, spans: [call('c1', 'claude-haiku-5-5', 100_000, 1_000)] })).estimate);
    expect(e.basis).toBe('token_usage');
    expect(e.notes).toBeUndefined();
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

  it('what such a trace records beyond the calls on its spans is priced as one more total, and a note says so', () => {
    // Three calls made, two on the spans: the 50,000 in and 1,000 out left of the total, 50,000 × 0.10 + 1,000 × 0.50 = $0.0055
    const e = estimatedOf(
      estimateTraceCost(base({ token_usage: { prompt_tokens: 260_000, completion_tokens: 3_000 }, spans: [call('c1', 'claude-haiku-5-5', 200_000, 1_000), call('c2', 'claude-haiku-5-5', 10_000, 1_000)] })).estimate,
    );
    expect(e.basis).toBe('calls');
    expect(e.calls.map((c) => c.cost_usd)).toEqual([0.1025, 0.0015, 0.0055]);
    expect(e.calls[2]).toMatchObject({ prompt_tokens: 50_000, completion_tokens: 1_000, input_usd_per_1m: 0.1 });
    expect(e.notes).toEqual([LONG_HAIKU, 'claude-haiku-5-5: token_usage records 50,000 input and 1,000 output tokens beyond the calls on the spans; they are priced as one more total.']);
  });

  it('a remainder over the line is priced at the base rates, and says the estimate may be low', () => {
    // gpt-5.4: 690,000 in and 1,000 out beyond the calls, 690,000 × 2.50 + 1,000 × 15 = $1.74
    const e = estimatedOf(
      estimateTraceCost(base({ token_usage: { prompt_tokens: 1_000_000, completion_tokens: 3_000 }, spans: [call('c1', 'gpt-5.4', 300_000, 1_000), call('c2', 'gpt-5.4', 10_000, 1_000)] })).estimate,
    );
    expect(e.calls).toHaveLength(3);
    expect(e.calls[2]).toMatchObject({ prompt_tokens: 690_000, input_usd_per_1m: 2.5, cost_usd: 1.74 });
    expect(e.notes).toContain('gpt-5.4: priced at the rates of a request of up to 272,000 input tokens. The 690,000 counted are a total over calls, which cannot say whether a call was over that size; such a call costs more, so the estimate may be low.');
  });

  it("cached counts beside a small input carry a call over the line, and a trace of one model is then priced call by call", () => {
    // 10,000 in and 95,000 read is a request of 105,000: 10,000 × 0.50 + 95,000 × 0.05 + 1,000 × 2.50 = $0.01225
    const e = estimatedOf(
      estimateTraceCost(base({ token_usage: { prompt_tokens: 10_000, completion_tokens: 1_000, cache_read_tokens: 95_000 }, spans: [call('c1', 'claude-haiku-5-5', 10_000, 1_000, { 'gen_ai.usage.cache_read.input_tokens': 95_000 })] })).estimate,
    );
    expect(e.basis).toBe('calls');
    expect(e.calls).toEqual([expect.objectContaining({ prompt_tokens: 105_000, input_usd_per_1m: 0.5, cost_usd: 0.01225 })]);
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

  it("a span carrying a whole run's usage beside the trace's token_usage, over the line: priced by the token_usage at the base rates, and it says so", () => {
    // The span's total is no call, so it carries no call over the line, and it cannot account for the total either.
    const e = estimatedOf(
      estimateTraceCost(base({ token_usage: { prompt_tokens: 300_000, completion_tokens: 1_000 }, spans: [span('run', { 'gen_ai.request.model': 'claude-haiku-5-5', 'gen_ai.aggregated_usage.input_tokens': 300_000, 'gen_ai.aggregated_usage.output_tokens': 1_000 })] })).estimate,
    );
    expect(e.basis).toBe('token_usage');
    expect(e.calls[0]).toMatchObject({ input_usd_per_1m: 0.1, cost_usd: 0.0305 });
    expect(e.notes).toEqual([totalNote('300,000')]);
  });

  it('a total is measured by its size: cached counts beside its input carry it over the line', () => {
    // 60,000 in beside 80,000 read is 140,000: 60,000 × 0.10 + 80,000 × 0.01 + 1,000 × 0.50 = $0.0073, and it may be low
    const alone = estimatedOf(estimateTraceCost(base({ token_usage: { prompt_tokens: 60_000, completion_tokens: 1_000, cache_read_tokens: 80_000 }, metadata: { model: 'claude-haiku-5-5' } })).estimate);
    expect(alone.calls[0]).toMatchObject({ prompt_tokens: 140_000, cost_usd: 0.0073 });
    expect(alone.notes).toContain(totalNote('140,000'));
    // Two calls of 40,000 do not account for a total of that size, though they account for its input count.
    const beside = estimatedOf(
      estimateTraceCost(base({ token_usage: { prompt_tokens: 60_000, completion_tokens: 1_000, cache_read_tokens: 80_000 }, spans: [call('c1', 'claude-haiku-5-5', 40_000, 500), call('c2', 'claude-haiku-5-5', 40_000, 500)] })).estimate,
    );
    expect(beside.basis).toBe('token_usage');
    expect(beside.notes).toContain(totalNote('140,000'));
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
