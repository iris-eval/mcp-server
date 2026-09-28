/*
 * Cached input tokens priced at the cache price (#702).
 *
 * The spans here are the ones Iris's own JavaScript wrapper records: each
 * provider-shaped response goes through `genAiSpan` (packages/sdk/src/genai.ts,
 * the mapping `wrapOpenAI` / `wrapAnthropic` send, held to the Python one by
 * the genai-parity fixture), is posted to POST /v1/traces on a real socket,
 * and the stored cost is checked against the provider's prices, worked by
 * hand from the table:
 *
 *   gpt-4o-mini       $0.15 input, $0.075 cache read, $0.60 output per 1M
 *   claude-sonnet-5   $2 input, $0.20 cache read, $2.50 cache write (5 min), $4 (1 hour), $10 output
 *
 * Then the other shapes a sender uses: OpenInference's prompt details, the
 * underscore attribute names that report Anthropic's cache counts beside the
 * input count, OpenAI's usage object pasted into log_trace, and a model priced
 * in config.json without cache prices.
 */
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { EvalEngine } from '../../src/eval/engine.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { setPricingSettings } from '../../src/cost/model-lookup.js';
import { genAiSpan, type Attributes, type CallRecord } from '../../packages/sdk/src/genai.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  setPricingSettings(undefined);
});

async function dashboard(): Promise<string> {
  const storage = new SqliteAdapter(':memory:');
  await storage.initialize();
  const config = { ...defaultConfig, dashboard: { ...defaultConfig.dashboard, port: 0 } };
  const evalEngine = new EvalEngine(config.eval.defaultThreshold, config.eval.ruleThresholds);
  const server: Server = createDashboardServer(storage, config, { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, { evalEngine }).start();
  await new Promise((r) => server.once('listening', r));
  cleanups.push(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    await storage.close();
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** An OTLP AnyValue for an attribute value; arrays of strings as arrayValue, anything else not a scalar left out. */
function anyValue(v: unknown): Record<string, unknown> | undefined {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: v } : { doubleValue: v };
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return { arrayValue: { values: v.map((x) => ({ stringValue: x })) } };
  return undefined;
}

let seq = 0;
function otlp(attributes: Record<string, unknown>): Record<string, unknown> {
  seq += 1;
  const hex = seq.toString(16).padStart(4, '0');
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'cache-bot' } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: `0af7651916cd43dd8448eb211c80${hex}`,
                spanId: `b7ad6b716920${hex}`,
                name: 'chat',
                startTimeUnixNano: '1759053600000000000',
                endTimeUnixNano: '1759053601000000000',
                attributes: Object.entries(attributes).flatMap(([key, v]) => {
                  const value = anyValue(v);
                  return value ? [{ key, value }] : [];
                }),
              },
            ],
          },
        ],
      },
    ],
  };
}

type Stored = { trace_id: string; cost_usd: number | null; cost_source?: string; cost_estimate?: { status: string; notes?: string[]; calls?: Array<Record<string, unknown>> } };

async function send(base: string, attributes: Record<string, unknown>): Promise<Stored> {
  const res = await fetch(`${base}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(otlp(attributes)) });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { 'iris-eval': { stored: Stored[] } };
  return body['iris-eval'].stored[0];
}

const wrapped = (call: CallRecord): Attributes => genAiSpan(call).attributes;

describe('OpenAI cached input, as wrapOpenAI records it', () => {
  it('prices the cached tokens at the cache-read price: $0.021, where the full input price gave $0.0285', async () => {
    const base = await dashboard();
    const attrs = wrapped({
      api: 'chat',
      request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Summarise the report.' }] },
      response: {
        id: 'chatcmpl-1',
        model: 'gpt-4o-mini-2024-07-18',
        choices: [{ index: 0, message: { role: 'assistant', content: 'The report says revenue grew.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 150_000, completion_tokens: 10_000, total_tokens: 160_000, prompt_tokens_details: { cached_tokens: 100_000 } },
      },
    });
    // What the wrapper sends: the input count includes the cached tokens, which are named apart.
    expect(attrs).toMatchObject({ 'gen_ai.usage.input_tokens': 150_000, 'gen_ai.usage.cache_read.input_tokens': 100_000, 'gen_ai.usage.output_tokens': 10_000 });
    const stored = await send(base, attrs);
    // 50,000 × $0.15 + 100,000 × $0.075 + 10,000 × $0.60 per 1M = $0.0075 + $0.0075 + $0.006
    expect(stored.cost_usd).toBeCloseTo(0.021, 12);
    expect(stored.cost_source).toBe('estimated');
    expect(stored.cost_estimate?.calls?.[0]).toMatchObject({ prompt_tokens: 150_000, cache_read_tokens: 100_000, cache_creation_tokens: 0, cache_read_usd_per_1m: 0.075, cache_write_usd_per_1m: 0.15 });
    expect(stored.cost_estimate?.notes).toBeUndefined();
  });
});

describe('an uncached call', () => {
  it('stores the token usage it always did: a wrapper’s cached_tokens: 0 adds no cache field', async () => {
    const base = await dashboard();
    const stored = await send(
      base,
      wrapped({
        api: 'chat',
        request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }] },
        response: { id: 'c', model: 'gpt-4o-mini', choices: [{ index: 0, message: { role: 'assistant', content: 'Hello.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16, prompt_tokens_details: { cached_tokens: 0 } } },
      }),
    );
    const detail = (await (await fetch(`${base}/api/v1/traces/${stored.trace_id}`)).json()) as { trace: { token_usage: unknown } };
    expect(detail.trace.token_usage).toEqual({ prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 });
    expect(stored.cost_estimate?.calls?.[0].cache_read_tokens).toBeUndefined();
  });
});

describe('Anthropic cache reads and writes, as wrapAnthropic records them', () => {
  it('prices reads at the cache-read price and writes at the 5-minute cache-write price: $0.084, where the full input price gave $0.254', async () => {
    const base = await dashboard();
    const attrs = wrapped({
      api: 'messages',
      request: { model: 'claude-sonnet-5', max_tokens: 2000, messages: [{ role: 'user', content: 'Summarise the report.' }] },
      response: {
        id: 'msg_1',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'The report says revenue grew.' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 2_000,
          output_tokens: 1_000,
          cache_read_input_tokens: 100_000,
          cache_creation_input_tokens: 20_000,
          cache_creation: { ephemeral_5m_input_tokens: 20_000, ephemeral_1h_input_tokens: 0 },
        },
      },
    });
    // The wrapper folds Anthropic's separate counts into the conventions' input count, and carries the write lifetimes.
    expect(attrs).toMatchObject({
      'gen_ai.usage.input_tokens': 122_000,
      'gen_ai.usage.cache_read.input_tokens': 100_000,
      'gen_ai.usage.cache_creation.input_tokens': 20_000,
      'iris.usage.cache_creation.ephemeral_1h_input_tokens': 0,
    });
    const stored = await send(base, attrs);
    // 2,000 × $2 + 100,000 × $0.20 + 20,000 × $2.50 + 1,000 × $10 per 1M = $0.004 + $0.02 + $0.05 + $0.01
    expect(stored.cost_usd).toBeCloseTo(0.084, 12);
    expect(stored.cost_estimate?.calls?.[0]).toMatchObject({ prompt_tokens: 122_000, cache_read_tokens: 100_000, cache_creation_tokens: 20_000, cache_read_usd_per_1m: 0.2, cache_write_usd_per_1m: 2.5 });
    expect(stored.cost_estimate?.notes).toBeUndefined();
  });

  it('1-hour cache writes at the 1-hour price: $0.1065 where every write at the 5-minute price gave $0.084', async () => {
    const base = await dashboard();
    const attrs = wrapped({
      api: 'messages',
      request: { model: 'claude-sonnet-5', max_tokens: 2000, messages: [{ role: 'user', content: 'Summarise the report.' }] },
      response: {
        id: 'msg_2',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'The report says revenue grew.' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 2_000,
          output_tokens: 1_000,
          cache_read_input_tokens: 100_000,
          cache_creation_input_tokens: 20_000,
          cache_creation: { ephemeral_5m_input_tokens: 5_000, ephemeral_1h_input_tokens: 15_000 },
        },
      },
    });
    expect(attrs).toMatchObject({ 'iris.usage.cache_creation.ephemeral_1h_input_tokens': 15_000 });
    const stored = await send(base, attrs);
    // 2,000 × $2 + 100,000 × $0.20 + 5,000 × $2.50 + 15,000 × $4 + 1,000 × $10 per 1M = $0.004 + $0.02 + $0.0125 + $0.06 + $0.01
    expect(stored.cost_usd).toBeCloseTo(0.1065, 12);
    expect(stored.cost_estimate?.calls?.[0]).toMatchObject({ cache_creation_tokens: 20_000, cache_creation_1h_tokens: 15_000, cache_write_usd_per_1m: 2.5, cache_write_1h_usd_per_1m: 4 });
    expect(stored.cost_estimate?.notes).toBeUndefined();
  });

  it('cache writes without the lifetime split are priced as 5-minute writes, and the estimate says so', async () => {
    const base = await dashboard();
    const stored = await send(base, {
      'gen_ai.request.model': 'claude-sonnet-5',
      'gen_ai.usage.input_tokens': 122_000,
      'gen_ai.usage.output_tokens': 1_000,
      'gen_ai.usage.cache_read.input_tokens': 100_000,
      'gen_ai.usage.cache_creation.input_tokens': 20_000,
      'gen_ai.completion': 'The report says revenue grew.',
    });
    expect(stored.cost_usd).toBeCloseTo(0.084, 12);
    expect(stored.cost_estimate?.notes).toEqual([
      'claude-sonnet-5: 20,000 cache-write tokens are priced as 5-minute writes; the trace does not say how many had a 1-hour lifetime, which costs more.',
    ]);
  });

  it('cache counts reported beside the input count (Anthropic API names, passed through) are added to it, and the estimate says so', async () => {
    const base = await dashboard();
    const stored = await send(base, {
      'gen_ai.request.model': 'claude-sonnet-5',
      'gen_ai.usage.input_tokens': 2_000,
      'gen_ai.usage.output_tokens': 1_000,
      'gen_ai.usage.cache_read_input_tokens': 100_000,
      'gen_ai.usage.cache_creation_input_tokens': 20_000,
      'gen_ai.completion': 'The report says revenue grew.',
    });
    expect(stored.cost_usd).toBeCloseTo(0.084, 12);
    expect(stored.cost_estimate?.calls?.[0]).toMatchObject({ prompt_tokens: 122_000 });
    expect(stored.cost_estimate?.notes).toEqual([
      "claude-sonnet-5: the cached counts (120,000) are more than the input count (2,000), so they were counted beside it, as Anthropic's API reports them, and added to it.",
      'claude-sonnet-5: 20,000 cache-write tokens are priced as 5-minute writes; the trace does not say how many had a 1-hour lifetime, which costs more.',
    ]);
  });
});

describe('the other senders', () => {
  it('OpenInference prompt details (llm.token_count.prompt_details.cache_read) price like the GenAI conventions', async () => {
    const base = await dashboard();
    const stored = await send(base, {
      'openinference.span.kind': 'LLM',
      'llm.model_name': 'gpt-4o-mini',
      'llm.token_count.prompt': 150_000,
      'llm.token_count.completion': 10_000,
      'llm.token_count.prompt_details.cache_read': 100_000,
      'output.value': 'The report says revenue grew.',
    });
    expect(stored.cost_usd).toBeCloseTo(0.021, 12);
  });

  it('log_trace and POST /api/v1/traces take OpenAI’s usage object as sent: prompt_tokens_details.cached_tokens is the cache read', async () => {
    const base = await dashboard();
    const res = await fetch(`${base}/api/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_name: 'cache-bot', output: 'ok', metadata: { model: 'gpt-4o-mini' }, token_usage: { prompt_tokens: 150_000, completion_tokens: 10_000, prompt_tokens_details: { cached_tokens: 100_000 } } }),
    });
    const body = (await res.json()) as Stored;
    expect(res.status).toBe(201);
    expect(body.cost_usd).toBeCloseTo(0.021, 12);
    // Iris's own field says the same, and wins when both are sent.
    const own = await fetch(`${base}/api/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_name: 'cache-bot', output: 'ok', metadata: { model: 'gpt-4o-mini' }, token_usage: { prompt_tokens: 150_000, completion_tokens: 10_000, cache_read_tokens: 100_000, prompt_tokens_details: { cached_tokens: 5 } } }),
    });
    expect(((await own.json()) as Stored).cost_usd).toBeCloseTo(0.021, 12);
  });

  it('a model priced in config.json without cache prices: cached tokens at its input price, as before, and the estimate says so', async () => {
    setPricingSettings({ estimate: true, models: [{ model: 'prod-gpt4o', inputUsdPer1M: 2, outputUsdPer1M: 8 }] });
    const base = await dashboard();
    const stored = await send(base, {
      'gen_ai.request.model': 'prod-gpt4o',
      'gen_ai.usage.input_tokens': 100_000,
      'gen_ai.usage.output_tokens': 10_000,
      'gen_ai.usage.cache_read.input_tokens': 60_000,
      'gen_ai.completion': 'ok',
    });
    // 100,000 × $2 + 10,000 × $8 per 1M: the cache read is not discounted without a price for it.
    expect(stored.cost_usd).toBeCloseTo(0.28, 12);
    expect(stored.cost_estimate?.notes).toEqual(['prod-gpt4o: 60,000 cache-read tokens are priced at the input price, because pricing.models in config.json names no cacheReadUsdPer1M for prod-gpt4o.']);
    // With the price named, the discount applies: 40,000 × $2 + 60,000 × $0.50 + 10,000 × $8.
    setPricingSettings({ estimate: true, models: [{ model: 'prod-gpt4o', inputUsdPer1M: 2, outputUsdPer1M: 8, cacheReadUsdPer1M: 0.5 }] });
    const priced = await send(base, {
      'gen_ai.request.model': 'prod-gpt4o',
      'gen_ai.usage.input_tokens': 100_000,
      'gen_ai.usage.output_tokens': 10_000,
      'gen_ai.usage.cache_read.input_tokens': 60_000,
      'gen_ai.completion': 'ok',
    });
    expect(priced.cost_usd).toBeCloseTo(0.19, 12);
    expect(priced.cost_estimate?.notes).toBeUndefined();
  });
});
