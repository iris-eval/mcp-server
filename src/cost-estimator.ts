/*
 * Cost estimator — converts (token-count × model) into USD cost.
 *
 * Pricing tables embedded here for the major providers. Updated when
 * provider pricing changes; provider documentation is the source of truth.
 *
 * v0.3.1 — first public surface.
 */

import { MODEL_PRICING } from './eval/llm-judge/pricing.js';

export type Provider = 'anthropic' | 'openai';

export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPerMillion: number;
  /** USD per 1M output tokens. */
  outputPerMillion: number;
}

/**
 * Pricing as of 2026-04-21. Verify against provider documentation
 * at minor-release boundaries.
 *
 * Sources:
 *  - Anthropic: anthropic.com/pricing
 *  - OpenAI: openai.com/api/pricing
 */
/*
 * Derived from the judge's pricing table (src/eval/llm-judge/pricing.ts),
 * which is the ONE table. This module carried its own copy from v0.3.1
 * with different model ids and older prices; two tables of one fact drift,
 * and the 2026-09-05 audit named this pair. Same shape as before, one source.
 */
export const PRICING: Record<Provider, Record<string, ModelPricing>> = MODEL_PRICING.reduce(
  (acc, p) => {
    acc[p.provider][p.model] = { inputPerMillion: p.inputUsdPer1M, outputPerMillion: p.outputUsdPer1M };
    return acc;
  },
  { anthropic: {}, openai: {} } as Record<Provider, Record<string, ModelPricing>>,
);

export interface EstimateInput {
  provider: Provider;
  /** Model name. Match keys in PRICING for exact pricing; otherwise estimate returns null. */
  model: string;
  /** Input token count for this call. */
  tokensIn: number;
  /** Output token count for this call. */
  tokensOut: number;
}

export interface CostEstimate {
  /** USD cost for the call. */
  totalUsd: number;
  /** USD cost for input tokens only. */
  inputUsd: number;
  /** USD cost for output tokens only. */
  outputUsd: number;
}

/**
 * Estimate USD cost for a single LLM call given token counts + model.
 * Returns null if the model is not in the pricing table — caller should
 * either supply pricing override or accept "unknown cost" for that call.
 */
export function estimateCost(input: EstimateInput): CostEstimate | null {
  const providerTable = PRICING[input.provider];
  if (!providerTable) return null;

  const pricing = providerTable[input.model];
  if (!pricing) return null;

  const inputUsd = (input.tokensIn / 1_000_000) * pricing.inputPerMillion;
  const outputUsd = (input.tokensOut / 1_000_000) * pricing.outputPerMillion;
  return {
    totalUsd: inputUsd + outputUsd,
    inputUsd,
    outputUsd,
  };
}

/**
 * Sum cost estimates across multiple calls. Skips calls where the model
 * is not in the pricing table; the caller can detect via the return's
 * `unknownModelCount`.
 */
export function estimateBatch(inputs: EstimateInput[]): {
  totalUsd: number;
  estimatedCount: number;
  unknownModelCount: number;
} {
  let totalUsd = 0;
  let estimatedCount = 0;
  let unknownModelCount = 0;
  for (const input of inputs) {
    const est = estimateCost(input);
    if (est === null) {
      unknownModelCount += 1;
    } else {
      totalUsd += est.totalUsd;
      estimatedCount += 1;
    }
  }
  return { totalUsd, estimatedCount, unknownModelCount };
}
