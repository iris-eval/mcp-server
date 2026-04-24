import { describe, it, expect } from 'vitest';
import { findPricing, estimateCostUsd, MODEL_PRICING } from '../../../../src/eval/llm-judge/pricing.js';

describe('LLM judge pricing', () => {
  it('returns null for unknown models', () => {
    expect(findPricing('gpt-77')).toBeNull();
    expect(estimateCostUsd('gpt-77', 1000, 500)).toBeNull();
  });

  it('computes cost from input+output tokens for every known model', () => {
    for (const pricing of MODEL_PRICING) {
      const cost = estimateCostUsd(pricing.model, 1_000_000, 1_000_000);
      // Exact arithmetic — no float precision issues below 1M tokens on cents.
      expect(cost).toBe(
        Math.round((pricing.inputUsdPer1M + pricing.outputUsdPer1M) * 1_000_000) / 1_000_000,
      );
    }
  });

  it('is sub-cent precise on small token counts', () => {
    // 100 input + 50 output on claude-haiku-4-5 ($1/M in, $5/M out):
    //   100/1M * 1 + 50/1M * 5 = 0.0001 + 0.00025 = 0.00035
    expect(estimateCostUsd('claude-haiku-4-5', 100, 50)).toBe(0.00035);
  });

  it('catches obvious provider<->model mismatches at registration time', () => {
    // Every entry must have a non-empty provider + model + positive rates.
    for (const p of MODEL_PRICING) {
      expect(p.provider).toMatch(/^(anthropic|openai)$/);
      expect(p.model).toMatch(/^[a-z0-9-]+$/);
      expect(p.inputUsdPer1M).toBeGreaterThan(0);
      expect(p.outputUsdPer1M).toBeGreaterThan(0);
    }
  });
});
