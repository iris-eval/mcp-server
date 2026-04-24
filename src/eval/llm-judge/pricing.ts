// Per-model input/output pricing in USD per 1M tokens. Sourced from the
// provider pricing pages as of 2026-04. Unknown models fall through to
// null — callers must handle that explicitly (see estimateCostUsd) rather
// than assume zero cost for a mis-typed model name.
//
// Update alongside a CHANGELOG entry when provider pricing shifts. Raising
// or lowering a rate is a user-facing change because existing deployments
// rely on these numbers for cost-cap decisions.

export interface ModelPricing {
  provider: 'anthropic' | 'openai';
  model: string;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
}

export const MODEL_PRICING: readonly ModelPricing[] = [
  // Anthropic — Claude 4 family
  { provider: 'anthropic', model: 'claude-opus-4-7', inputUsdPer1M: 15, outputUsdPer1M: 75 },
  { provider: 'anthropic', model: 'claude-sonnet-4-6', inputUsdPer1M: 3, outputUsdPer1M: 15 },
  { provider: 'anthropic', model: 'claude-haiku-4-5', inputUsdPer1M: 1, outputUsdPer1M: 5 },
  { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', inputUsdPer1M: 1, outputUsdPer1M: 5 },

  // OpenAI — GPT-4o family + o1
  { provider: 'openai', model: 'gpt-4o', inputUsdPer1M: 2.5, outputUsdPer1M: 10 },
  { provider: 'openai', model: 'gpt-4o-mini', inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  { provider: 'openai', model: 'o1-mini', inputUsdPer1M: 3, outputUsdPer1M: 12 },
] as const;

export function findPricing(model: string): ModelPricing | null {
  return MODEL_PRICING.find((p) => p.model === model) ?? null;
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
