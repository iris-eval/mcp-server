/*
 * Per-model input/output pricing in USD per 1M tokens — the ONE table.
 *
 * The cost cap refuses a judge call whose worst case exceeds it, so a price
 * that is too high refuses calls that fit and a price that is too low lets
 * a call through the cap. Both are user-facing: raising or lowering a rate
 * ships with a CHANGELOG entry, and the guide's table (docs/llm-as-judge.md)
 * is held to this file by a test rather than kept by hand.
 *
 * Read from the providers' own pricing pages on PRICING_SOURCED_ON; the two
 * URLs are PRICING_SOURCES. A model the provider no longer prices is kept
 * with `retired` set to the date it was found absent, so a trace that
 * recorded it keeps its cost at the last known price — it is never silently
 * deleted. A judge named on a model the provider has shut down fails at the
 * provider.
 *
 * Unknown models fall through to null — callers must handle that explicitly
 * (see estimateCostUsd) rather than assume zero cost for a mis-typed name.
 */

export type PricingProvider = 'anthropic' | 'openai';

export interface ModelPricing {
  provider: PricingProvider;
  model: string;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  /**
   * USD per 1M input tokens read from the prompt cache. It prices a trace's
   * cost (src/cost/trace-cost.ts), and the input of a judge request that its
   * reply says was read from the cache; the judge asks for no caching.
   */
  cacheReadUsdPer1M: number;
  /**
   * USD per 1M input tokens written to the prompt cache. Anthropic charges
   * 1.25x the input price for a 5-minute write (the default lifetime; a
   * 1-hour write is cacheWrite1hUsdPer1M). OpenAI charges for a write from
   * GPT-5.6: 1.25x the input for a 30-minute write, the price here, and 2.5x
   * for a 12-hour write, which is not priced, since nothing a trace carries
   * that Iris reads splits the two. For its earlier models a written token is
   * an input token, and this is their input price.
   */
  cacheWriteUsdPer1M: number;
  /**
   * USD per 1M input tokens written to the prompt cache with a 1-hour
   * lifetime: 2x the input on Anthropic's pricing page. Priced only when the
   * trace carries Anthropic's split of its cache writes (the wrappers send
   * it as `iris.usage.cache_creation.ephemeral_1h_input_tokens`); absent for
   * a provider without the lifetime.
   */
  cacheWrite1hUsdPer1M?: number;
  /** ISO date the provider's pricing page was found to no longer list this model; the price is the last one it did list. */
  retired?: string;
  /**
   * The rates of a request over a number of input tokens, where the
   * provider prices such a request higher as a whole: Anthropic for
   * Claude Haiku 5.5 over 100,000 prompt tokens, OpenAI from GPT-5.4 over
   * 272,000 input tokens. A request's size counts every input token, its
   * cache reads and writes included, and each request is priced on its own.
   */
  longContext?: LongContextPricing;
}

/** The rates a request over `aboveInputTokens` input tokens is priced at, every token of it. */
export interface LongContextPricing {
  aboveInputTokens: number;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cacheReadUsdPer1M: number;
  cacheWriteUsdPer1M: number;
  cacheWrite1hUsdPer1M?: number;
}

/** The date the table was last read from PRICING_SOURCES. */
export const PRICING_SOURCED_ON = '2026-11-18';

/**
 * Where each provider's prices were read. Anthropic's docs pricing page
 * lists every column, the long-request rates of Claude Haiku 5.5 included;
 * OpenAI's pricing page lists the short- and long-context rates, and each
 * model's own page says whether it takes Chat Completions and structured
 * output, which the judge needs.
 */
export const PRICING_SOURCES: Readonly<Record<PricingProvider, string>> = {
  anthropic: 'https://platform.claude.com/docs/en/about-claude/pricing',
  openai: 'https://developers.openai.com/api/docs/pricing',
};

/**
 * Where the cache prices were read, beside PRICING_SOURCES: Anthropic's
 * cache-write and cache-hit columns are on the same docs pricing page, and
 * OpenAI's rule for cache writes is in its prompt-caching guide.
 */
export const CACHE_PRICING_SOURCES: Readonly<Record<PricingProvider, readonly string[]>> = {
  anthropic: ['https://platform.claude.com/docs/en/about-claude/pricing'],
  openai: ['https://developers.openai.com/api/docs/pricing', 'https://developers.openai.com/api/docs/guides/prompt-caching'],
};

export const MODEL_PRICING: readonly ModelPricing[] = [
  // Anthropic — current, in the order its models page lists them
  { provider: 'anthropic', model: 'claude-fable-5-2', inputUsdPer1M: 8, outputUsdPer1M: 40, cacheReadUsdPer1M: 0.2, cacheWriteUsdPer1M: 10, cacheWrite1hUsdPer1M: 16 },
  { provider: 'anthropic', model: 'claude-opus-5-5', inputUsdPer1M: 4, outputUsdPer1M: 20, cacheReadUsdPer1M: 0.2, cacheWriteUsdPer1M: 5, cacheWrite1hUsdPer1M: 8 },
  { provider: 'anthropic', model: 'claude-sonnet-5-5', inputUsdPer1M: 2, outputUsdPer1M: 10, cacheReadUsdPer1M: 0.1, cacheWriteUsdPer1M: 2.5, cacheWrite1hUsdPer1M: 4 },
  { provider: 'anthropic', model: 'claude-haiku-5-5', inputUsdPer1M: 0.1, outputUsdPer1M: 0.5, cacheReadUsdPer1M: 0.01, cacheWriteUsdPer1M: 0.125, cacheWrite1hUsdPer1M: 0.2, longContext: { aboveInputTokens: 100_000, inputUsdPer1M: 0.5, outputUsdPer1M: 2.5, cacheReadUsdPer1M: 0.05, cacheWriteUsdPer1M: 0.625, cacheWrite1hUsdPer1M: 1 } },
  // Anthropic — earlier, still served and priced
  { provider: 'anthropic', model: 'claude-fable-5-1', inputUsdPer1M: 10, outputUsdPer1M: 50, cacheReadUsdPer1M: 0.25, cacheWriteUsdPer1M: 12.5, cacheWrite1hUsdPer1M: 20 },
  { provider: 'anthropic', model: 'claude-fable-5', inputUsdPer1M: 10, outputUsdPer1M: 50, cacheReadUsdPer1M: 1, cacheWriteUsdPer1M: 12.5, cacheWrite1hUsdPer1M: 20 },
  { provider: 'anthropic', model: 'claude-opus-5', inputUsdPer1M: 5, outputUsdPer1M: 25, cacheReadUsdPer1M: 0.5, cacheWriteUsdPer1M: 6.25, cacheWrite1hUsdPer1M: 10 },
  { provider: 'anthropic', model: 'claude-sonnet-5', inputUsdPer1M: 2, outputUsdPer1M: 10, cacheReadUsdPer1M: 0.2, cacheWriteUsdPer1M: 2.5, cacheWrite1hUsdPer1M: 4 },
  { provider: 'anthropic', model: 'claude-haiku-4-5', inputUsdPer1M: 1, outputUsdPer1M: 5, cacheReadUsdPer1M: 0.1, cacheWriteUsdPer1M: 1.25, cacheWrite1hUsdPer1M: 2 },
  { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', inputUsdPer1M: 1, outputUsdPer1M: 5, cacheReadUsdPer1M: 0.1, cacheWriteUsdPer1M: 1.25, cacheWrite1hUsdPer1M: 2 },
  // Anthropic — the 4.x line, still priced
  { provider: 'anthropic', model: 'claude-opus-4-8', inputUsdPer1M: 5, outputUsdPer1M: 25, cacheReadUsdPer1M: 0.5, cacheWriteUsdPer1M: 6.25, cacheWrite1hUsdPer1M: 10 },
  { provider: 'anthropic', model: 'claude-opus-4-7', inputUsdPer1M: 5, outputUsdPer1M: 25, cacheReadUsdPer1M: 0.5, cacheWriteUsdPer1M: 6.25, cacheWrite1hUsdPer1M: 10 },
  { provider: 'anthropic', model: 'claude-opus-4-6', inputUsdPer1M: 5, outputUsdPer1M: 25, cacheReadUsdPer1M: 0.5, cacheWriteUsdPer1M: 6.25, cacheWrite1hUsdPer1M: 10 },
  { provider: 'anthropic', model: 'claude-sonnet-4-6', inputUsdPer1M: 3, outputUsdPer1M: 15, cacheReadUsdPer1M: 0.3, cacheWriteUsdPer1M: 3.75, cacheWrite1hUsdPer1M: 6 },
  { provider: 'anthropic', model: 'claude-opus-4-5', inputUsdPer1M: 5, outputUsdPer1M: 25, cacheReadUsdPer1M: 0.5, cacheWriteUsdPer1M: 6.25, cacheWrite1hUsdPer1M: 10 },
  // Retires on the Claude API on 2026-11-30 (the provider's model deprecations page).
  { provider: 'anthropic', model: 'claude-sonnet-4-5', inputUsdPer1M: 3, outputUsdPer1M: 15, cacheReadUsdPer1M: 0.3, cacheWriteUsdPer1M: 3.75, cacheWrite1hUsdPer1M: 6 },

  // OpenAI — current: the four its models page features, then the rest of GPT-6 and GPT-5.6
  { provider: 'openai', model: 'gpt-6.2-astra', inputUsdPer1M: 8, outputUsdPer1M: 40, cacheReadUsdPer1M: 0.4, cacheWriteUsdPer1M: 10, longContext: { aboveInputTokens: 272_000, inputUsdPer1M: 16, outputUsdPer1M: 60, cacheReadUsdPer1M: 0.8, cacheWriteUsdPer1M: 20 } },
  { provider: 'openai', model: 'gpt-6.2-sol', inputUsdPer1M: 2, outputUsdPer1M: 10, cacheReadUsdPer1M: 0.1, cacheWriteUsdPer1M: 2.5, longContext: { aboveInputTokens: 272_000, inputUsdPer1M: 4, outputUsdPer1M: 15, cacheReadUsdPer1M: 0.2, cacheWriteUsdPer1M: 5 } },
  { provider: 'openai', model: 'gpt-6.1-terra', inputUsdPer1M: 1, outputUsdPer1M: 5, cacheReadUsdPer1M: 0.05, cacheWriteUsdPer1M: 1.25, longContext: { aboveInputTokens: 272_000, inputUsdPer1M: 2, outputUsdPer1M: 7.5, cacheReadUsdPer1M: 0.1, cacheWriteUsdPer1M: 2.5 } },
  { provider: 'openai', model: 'gpt-6-luna', inputUsdPer1M: 0.1, outputUsdPer1M: 0.5, cacheReadUsdPer1M: 0.01, cacheWriteUsdPer1M: 0.125, longContext: { aboveInputTokens: 272_000, inputUsdPer1M: 0.2, outputUsdPer1M: 0.75, cacheReadUsdPer1M: 0.02, cacheWriteUsdPer1M: 0.25 } },
  { provider: 'openai', model: 'gpt-6.1-sol', inputUsdPer1M: 2, outputUsdPer1M: 10, cacheReadUsdPer1M: 0.1, cacheWriteUsdPer1M: 2.5, longContext: { aboveInputTokens: 272_000, inputUsdPer1M: 4, outputUsdPer1M: 15, cacheReadUsdPer1M: 0.2, cacheWriteUsdPer1M: 5 } },
  { provider: 'openai', model: 'gpt-6-astra', inputUsdPer1M: 10, outputUsdPer1M: 50, cacheReadUsdPer1M: 1, cacheWriteUsdPer1M: 12.5, longContext: { aboveInputTokens: 272_000, inputUsdPer1M: 20, outputUsdPer1M: 75, cacheReadUsdPer1M: 2, cacheWriteUsdPer1M: 25 } },
  { provider: 'openai', model: 'gpt-6-sol', inputUsdPer1M: 2, outputUsdPer1M: 10, cacheReadUsdPer1M: 0.2, cacheWriteUsdPer1M: 2.5, longContext: { aboveInputTokens: 272_000, inputUsdPer1M: 4, outputUsdPer1M: 15, cacheReadUsdPer1M: 0.4, cacheWriteUsdPer1M: 5 } },
  { provider: 'openai', model: 'gpt-5.6-terra', inputUsdPer1M: 2, outputUsdPer1M: 12, cacheReadUsdPer1M: 0.2, cacheWriteUsdPer1M: 2.5, longContext: { aboveInputTokens: 272_000, inputUsdPer1M: 4, outputUsdPer1M: 18, cacheReadUsdPer1M: 0.4, cacheWriteUsdPer1M: 5 } },
  { provider: 'openai', model: 'gpt-5.6-luna', inputUsdPer1M: 0.2, outputUsdPer1M: 1.2, cacheReadUsdPer1M: 0.02, cacheWriteUsdPer1M: 0.25, longContext: { aboveInputTokens: 272_000, inputUsdPer1M: 0.4, outputUsdPer1M: 1.8, cacheReadUsdPer1M: 0.04, cacheWriteUsdPer1M: 0.5 } },
  // OpenAI — earlier, still on its pricing page (some marked deprecated on their model pages)
  { provider: 'openai', model: 'gpt-5.5', inputUsdPer1M: 5, outputUsdPer1M: 30, cacheReadUsdPer1M: 0.5, cacheWriteUsdPer1M: 5, longContext: { aboveInputTokens: 272_000, inputUsdPer1M: 10, outputUsdPer1M: 45, cacheReadUsdPer1M: 1, cacheWriteUsdPer1M: 10 } },
  { provider: 'openai', model: 'gpt-5.4', inputUsdPer1M: 2.5, outputUsdPer1M: 15, cacheReadUsdPer1M: 0.25, cacheWriteUsdPer1M: 2.5, longContext: { aboveInputTokens: 272_000, inputUsdPer1M: 5, outputUsdPer1M: 22.5, cacheReadUsdPer1M: 0.5, cacheWriteUsdPer1M: 5 } },
  { provider: 'openai', model: 'gpt-5.4-mini', inputUsdPer1M: 0.75, outputUsdPer1M: 4.5, cacheReadUsdPer1M: 0.075, cacheWriteUsdPer1M: 0.75 },
  { provider: 'openai', model: 'gpt-5.4-nano', inputUsdPer1M: 0.2, outputUsdPer1M: 1.25, cacheReadUsdPer1M: 0.02, cacheWriteUsdPer1M: 0.2 },
  { provider: 'openai', model: 'gpt-5.2', inputUsdPer1M: 1.75, outputUsdPer1M: 14, cacheReadUsdPer1M: 0.175, cacheWriteUsdPer1M: 1.75 },
  { provider: 'openai', model: 'gpt-5.1', inputUsdPer1M: 1.25, outputUsdPer1M: 10, cacheReadUsdPer1M: 0.125, cacheWriteUsdPer1M: 1.25 },
  { provider: 'openai', model: 'gpt-5', inputUsdPer1M: 1.25, outputUsdPer1M: 10, cacheReadUsdPer1M: 0.125, cacheWriteUsdPer1M: 1.25 },
  { provider: 'openai', model: 'gpt-5-mini', inputUsdPer1M: 0.25, outputUsdPer1M: 2, cacheReadUsdPer1M: 0.025, cacheWriteUsdPer1M: 0.25 },
  { provider: 'openai', model: 'gpt-5-nano', inputUsdPer1M: 0.05, outputUsdPer1M: 0.4, cacheReadUsdPer1M: 0.005, cacheWriteUsdPer1M: 0.05 },
  { provider: 'openai', model: 'gpt-4.1', inputUsdPer1M: 2, outputUsdPer1M: 8, cacheReadUsdPer1M: 0.5, cacheWriteUsdPer1M: 2 },
  { provider: 'openai', model: 'gpt-4.1-mini', inputUsdPer1M: 0.4, outputUsdPer1M: 1.6, cacheReadUsdPer1M: 0.1, cacheWriteUsdPer1M: 0.4 },
  { provider: 'openai', model: 'gpt-4o', inputUsdPer1M: 2.5, outputUsdPer1M: 10, cacheReadUsdPer1M: 1.25, cacheWriteUsdPer1M: 2.5 },
  { provider: 'openai', model: 'gpt-4o-mini', inputUsdPer1M: 0.15, outputUsdPer1M: 0.6, cacheReadUsdPer1M: 0.075, cacheWriteUsdPer1M: 0.15 },
  { provider: 'openai', model: 'o3', inputUsdPer1M: 2, outputUsdPer1M: 8, cacheReadUsdPer1M: 0.5, cacheWriteUsdPer1M: 2 },
  /*
   * OpenAI — retired from the provider's pricing page; kept so a trace that recorded one still has a cost.
   * o1-mini was carried at $3 / $12, its launch price. OpenAI's own model
   * page (https://developers.openai.com/api/docs/models/o1-mini, read
   * 2026-09-28) lists $1.10 / $4.40 and $0.55 cached, the same as
   * o3-mini; the pricing page no longer lists the model at all. o4-mini
   * and o3-mini were gone from it on 2026-11-18, and their model pages
   * say they are shut down.
   */
  { provider: 'openai', model: 'o4-mini', inputUsdPer1M: 1.1, outputUsdPer1M: 4.4, cacheReadUsdPer1M: 0.275, cacheWriteUsdPer1M: 1.1, retired: '2026-11-18' },
  { provider: 'openai', model: 'o3-mini', inputUsdPer1M: 1.1, outputUsdPer1M: 4.4, cacheReadUsdPer1M: 0.55, cacheWriteUsdPer1M: 1.1, retired: '2026-11-18' },
  { provider: 'openai', model: 'o1-mini', inputUsdPer1M: 1.1, outputUsdPer1M: 4.4, cacheReadUsdPer1M: 0.55, cacheWriteUsdPer1M: 1.1, retired: '2026-09-20' },
] as const;

/**
 * Dated snapshot ids that ARE a priced model, each mapped to its row above.
 *
 * Used only to price a trace's recorded model (src/cost/model-lookup.ts),
 * never by the judge, which calls the id it was given. A snapshot is listed
 * here only when the provider prices it the same as the row it maps to, so
 * no date is ever stripped by rule: gpt-4o-2024-05-13 is deliberately
 * absent because OpenAI priced it at $5 / $15, not gpt-4o's $2.50 / $10, and
 * a rule that dropped the date would have priced it at half. A snapshot not
 * listed is reported as an unknown model, never guessed. Each pair was read
 * from the model's own page (its snapshot list and price) on the provider's
 * docs, on 2026-09-28 or, for the models added then, 2026-11-18; the pages of
 * GPT-5.6 and GPT-6 list no dated snapshot. From the 4.6 generation on,
 * Anthropic's ids carry no date, so they need no entry. A fine-tuned id
 * (`ft:gpt-4o-mini-2024-07-18:...`) is priced differently and matches nothing here.
 */
export const MODEL_SNAPSHOTS: Readonly<Record<string, string>> = {
  // OpenAI
  'gpt-5.5-2026-04-23': 'gpt-5.5',
  'gpt-5.4-2026-03-05': 'gpt-5.4',
  'gpt-5.4-mini-2026-03-17': 'gpt-5.4-mini',
  'gpt-5.4-nano-2026-03-17': 'gpt-5.4-nano',
  'gpt-5.2-2025-12-11': 'gpt-5.2',
  'gpt-5.1-2025-11-13': 'gpt-5.1',
  'gpt-5-2025-08-07': 'gpt-5',
  'gpt-5-mini-2025-08-07': 'gpt-5-mini',
  'gpt-5-nano-2025-08-07': 'gpt-5-nano',
  'gpt-4.1-2025-04-14': 'gpt-4.1',
  'gpt-4.1-mini-2025-04-14': 'gpt-4.1-mini',
  'gpt-4o-2024-08-06': 'gpt-4o',
  'gpt-4o-2024-11-20': 'gpt-4o',
  'gpt-4o-mini-2024-07-18': 'gpt-4o-mini',
  'o4-mini-2025-04-16': 'o4-mini',
  'o3-2025-04-16': 'o3',
  'o3-mini-2025-01-31': 'o3-mini',
  'o1-mini-2024-09-12': 'o1-mini',
  // Anthropic
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5',
  'claude-opus-4-5-20251101': 'claude-opus-4-5',
};

export function findPricing(model: string): ModelPricing | null {
  return MODEL_PRICING.find((p) => p.model === model) ?? null;
}

/** Every priced model id, retired ones included (a trace that recorded one is still priced), in table order. */
export function pricedModels(provider?: PricingProvider): string[] {
  return MODEL_PRICING.filter((p) => provider === undefined || p.provider === provider).map((p) => p.model);
}

/**
 * The short form a tool description carries: the first four current
 * models per provider, in table order (each provider's four latest). The
 * full list rides IRIS_JUDGE_UNKNOWN_MODEL's `valid`, so a wrong guess is
 * answered with every id — the description stays inside the word cap.
 */
export function supportedModelsSummary(): string {
  const lead = (provider: PricingProvider): string =>
    MODEL_PRICING.filter((p) => p.provider === provider && !p.retired)
      .slice(0, 4)
      .map((p) => p.model)
      .join(' | ');
  return `anthropic = ${lead('anthropic')} (and earlier Claude models); openai = ${lead('openai')} (and earlier GPT models, and o3)`;
}

/** The rates one request is priced at: the row's own, or its long-context rates when its input tokens are over the line. */
export type RequestRates = Pick<ModelPricing, 'inputUsdPer1M' | 'outputUsdPer1M' | 'cacheReadUsdPer1M' | 'cacheWriteUsdPer1M' | 'cacheWrite1hUsdPer1M'>;

export function ratesFor(pricing: ModelPricing, inputTokens: number): RequestRates {
  const long = pricing.longContext;
  return long !== undefined && inputTokens > long.aboveInputTokens ? long : pricing;
}

/** Of a request's input tokens, those its provider read from its cache and those it wrote to it (OpenAI counts both within the input). */
export interface CachedInput {
  readTokens?: number;
  writeTokens?: number;
}

/**
 * What ONE request cost: its size picks the rates every token of it is
 * priced at, so two requests are priced one by one and added, never as one
 * request of their summed size. Input the provider reports it read from its
 * cache is priced at the cache-read rate, and input it wrote at the write
 * rate; the rest at the input rate.
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cached: CachedInput = {},
): number | null {
  const pricing = findPricing(model);
  if (!pricing) return null;
  const rates = ratesFor(pricing, inputTokens);
  const read = Math.min(Math.max(cached.readTokens ?? 0, 0), inputTokens);
  const written = Math.min(Math.max(cached.writeTokens ?? 0, 0), inputTokens - read);
  const inputCost =
    ((inputTokens - read - written) / 1_000_000) * rates.inputUsdPer1M +
    (read / 1_000_000) * rates.cacheReadUsdPer1M +
    (written / 1_000_000) * rates.cacheWriteUsdPer1M;
  const outputCost = (outputTokens / 1_000_000) * rates.outputUsdPer1M;
  // Round to 6 decimal places — sub-cent precision, avoids float drift.
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}

/**
 * How many times its estimate a request's input is counted in a cost cap's
 * worst case. The estimate is four characters a token (client.ts,
 * estimateInputTokens); Anthropic's newer tokenizer, Claude 4.7 and later,
 * makes about 30% more tokens of the same text than its earlier one did.
 * Text denser than prose (code, a script other than Latin) can make more
 * tokens than this counts, on any model.
 */
export const INPUT_ESTIMATE_MARGIN = 1.3;

/**
 * The most ONE request can cost, for a cost cap, when its input makes no
 * more than INPUT_ESTIMATE_MARGIN times the tokens its estimate counts: that
 * many input tokens and its whole output cap, at the rates for a request of
 * that size, so at the higher rates of a long request wherever that count is
 * over the line. Near the line an estimate can fall short of it while the
 * request is over it, and there the higher rates cost several times the
 * base ones.
 */
export function worstCaseRequestUsd(model: string, inputTokensEstimate: number, maxOutputTokens: number): number | null {
  const pricing = findPricing(model);
  if (!pricing) return null;
  const input = Math.ceil(inputTokensEstimate * INPUT_ESTIMATE_MARGIN);
  const rates = ratesFor(pricing, input);
  const cost = (input / 1_000_000) * rates.inputUsdPer1M + (maxOutputTokens / 1_000_000) * rates.outputUsdPer1M;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
