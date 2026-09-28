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
 * with `retired` set to the date it was found absent, so an existing
 * configuration keeps working at the last known price and the response can
 * say so — it is never silently deleted.
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
  /** ISO date the provider's pricing page was found to no longer list this model; the price is the last one it did list. */
  retired?: string;
}

/** The date the table was last read from PRICING_SOURCES. */
export const PRICING_SOURCED_ON = '2026-09-25';

export const PRICING_SOURCES: Readonly<Record<PricingProvider, string>> = {
  anthropic: 'https://claude.com/pricing',
  openai: 'https://developers.openai.com/api/docs/pricing',
};

export const MODEL_PRICING: readonly ModelPricing[] = [
  // Anthropic — current
  { provider: 'anthropic', model: 'claude-fable-5-1', inputUsdPer1M: 10, outputUsdPer1M: 50 },
  { provider: 'anthropic', model: 'claude-opus-5-5', inputUsdPer1M: 4, outputUsdPer1M: 20 },
  { provider: 'anthropic', model: 'claude-sonnet-5', inputUsdPer1M: 2, outputUsdPer1M: 10 },
  { provider: 'anthropic', model: 'claude-haiku-4-5', inputUsdPer1M: 1, outputUsdPer1M: 5 },
  { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', inputUsdPer1M: 1, outputUsdPer1M: 5 },
  // Anthropic — legacy on the provider's page, still priced
  { provider: 'anthropic', model: 'claude-opus-5', inputUsdPer1M: 5, outputUsdPer1M: 25 },
  // Anthropic — the 4.x line, still priced
  { provider: 'anthropic', model: 'claude-opus-4-8', inputUsdPer1M: 5, outputUsdPer1M: 25 },
  { provider: 'anthropic', model: 'claude-opus-4-7', inputUsdPer1M: 5, outputUsdPer1M: 25 },
  { provider: 'anthropic', model: 'claude-opus-4-6', inputUsdPer1M: 5, outputUsdPer1M: 25 },
  { provider: 'anthropic', model: 'claude-sonnet-4-6', inputUsdPer1M: 3, outputUsdPer1M: 15 },
  { provider: 'anthropic', model: 'claude-opus-4-5', inputUsdPer1M: 5, outputUsdPer1M: 25 },
  { provider: 'anthropic', model: 'claude-sonnet-4-5', inputUsdPer1M: 3, outputUsdPer1M: 15 },

  // OpenAI — current
  { provider: 'openai', model: 'gpt-5', inputUsdPer1M: 1.25, outputUsdPer1M: 10 },
  { provider: 'openai', model: 'gpt-5-mini', inputUsdPer1M: 0.25, outputUsdPer1M: 2 },
  { provider: 'openai', model: 'gpt-4.1-mini', inputUsdPer1M: 0.4, outputUsdPer1M: 1.6 },
  { provider: 'openai', model: 'gpt-4o', inputUsdPer1M: 2.5, outputUsdPer1M: 10 },
  { provider: 'openai', model: 'gpt-4o-mini', inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  { provider: 'openai', model: 'o4-mini', inputUsdPer1M: 1.1, outputUsdPer1M: 4.4 },
  { provider: 'openai', model: 'o3-mini', inputUsdPer1M: 1.1, outputUsdPer1M: 4.4 },
  // OpenAI — retired from the provider's pricing page; last known price kept
  { provider: 'openai', model: 'o1-mini', inputUsdPer1M: 3, outputUsdPer1M: 12, retired: '2026-09-20' },
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
 * docs on 2026-09-28. From the 4.6 generation on, Anthropic's ids carry no
 * date, so they need no entry. A fine-tuned id (`ft:gpt-4o-mini-2024-07-18:...`)
 * is priced differently and matches nothing here.
 */
export const MODEL_SNAPSHOTS: Readonly<Record<string, string>> = {
  // OpenAI
  'gpt-5-2025-08-07': 'gpt-5',
  'gpt-5-mini-2025-08-07': 'gpt-5-mini',
  'gpt-4.1-mini-2025-04-14': 'gpt-4.1-mini',
  'gpt-4o-2024-08-06': 'gpt-4o',
  'gpt-4o-2024-11-20': 'gpt-4o',
  'gpt-4o-mini-2024-07-18': 'gpt-4o-mini',
  'o4-mini-2025-04-16': 'o4-mini',
  'o3-mini-2025-01-31': 'o3-mini',
  // Anthropic
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5',
  'claude-opus-4-5-20251101': 'claude-opus-4-5',
};

export function findPricing(model: string): ModelPricing | null {
  return MODEL_PRICING.find((p) => p.model === model) ?? null;
}

/** Every priced model id, retired ones included (they still work), in table order. */
export function pricedModels(provider?: PricingProvider): string[] {
  return MODEL_PRICING.filter((p) => provider === undefined || p.provider === provider).map((p) => p.model);
}

/**
 * The short form a tool description carries: the first three current
 * models per provider, in table order. The full list rides
 * IRIS_JUDGE_UNKNOWN_MODEL's `valid`, so a wrong guess is answered with
 * every id — the description stays inside the word cap.
 */
export function supportedModelsSummary(): string {
  const lead = (provider: PricingProvider): string =>
    MODEL_PRICING.filter((p) => p.provider === provider && !p.retired)
      .slice(0, 3)
      .map((p) => p.model)
      .join(' | ');
  return `anthropic = ${lead('anthropic')} (and the priced 4.x line); openai = ${lead('openai')} (and the priced 4o, o3/o4 and retired o1 ids)`;
}

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const pricing = findPricing(model);
  if (!pricing) return null;
  const inputCost = (inputTokens / 1_000_000) * pricing.inputUsdPer1M;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputUsdPer1M;
  // Round to 6 decimal places — sub-cent precision, avoids float drift.
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}
