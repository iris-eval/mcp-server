import { describe, expect, it } from 'vitest';
import {
  estimateBatch,
  estimateCost,
  PRICING,
} from '../src/cost-estimator.js';

describe('estimateCost', () => {
  it('computes input + output USD for a known anthropic model', () => {
    const result = estimateCost({
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      tokensIn: 1_000_000,
      tokensOut: 500_000,
    });
    expect(result).not.toBeNull();
    expect(result?.inputUsd).toBeCloseTo(3, 5);    // $3 per 1M input
    expect(result?.outputUsd).toBeCloseTo(7.5, 5); // $15 per 1M × 0.5M = $7.50
    expect(result?.totalUsd).toBeCloseTo(10.5, 5);
  });

  it('computes cost for a known openai model', () => {
    const result = estimateCost({
      provider: 'openai',
      model: 'gpt-4o-mini',
      tokensIn: 100_000,
      tokensOut: 50_000,
    });
    expect(result).not.toBeNull();
    // gpt-4o-mini: $0.15 per 1M input, $0.60 per 1M output
    expect(result?.inputUsd).toBeCloseTo(0.015, 5);
    expect(result?.outputUsd).toBeCloseTo(0.03, 5);
    expect(result?.totalUsd).toBeCloseTo(0.045, 5);
  });

  it('returns null when the model is not in the pricing table', () => {
    expect(
      estimateCost({
        provider: 'anthropic',
        model: 'unknown-future-model',
        tokensIn: 100,
        tokensOut: 100,
      }),
    ).toBeNull();
  });

  it('returns null when the provider is not in the pricing table', () => {
    expect(
      estimateCost({
        // @ts-expect-error — intentionally pass an unknown provider
        provider: 'fictitious',
        model: 'whatever',
        tokensIn: 100,
        tokensOut: 100,
      }),
    ).toBeNull();
  });

  it('handles zero tokens cleanly', () => {
    const result = estimateCost({
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      tokensIn: 0,
      tokensOut: 0,
    });
    expect(result?.totalUsd).toBe(0);
  });
});

describe('estimateBatch', () => {
  it('sums known-model costs and counts unknown models', () => {
    const result = estimateBatch([
      { provider: 'anthropic', model: 'claude-sonnet-4', tokensIn: 1_000_000, tokensOut: 0 },
      { provider: 'openai', model: 'gpt-4o-mini', tokensIn: 1_000_000, tokensOut: 0 },
      { provider: 'anthropic', model: 'unknown-model', tokensIn: 100, tokensOut: 100 },
    ]);
    expect(result.estimatedCount).toBe(2);
    expect(result.unknownModelCount).toBe(1);
    // $3 (claude-sonnet-4 input) + $0.15 (gpt-4o-mini input) = $3.15
    expect(result.totalUsd).toBeCloseTo(3.15, 5);
  });

  it('returns zeros for an empty batch', () => {
    const result = estimateBatch([]);
    expect(result.totalUsd).toBe(0);
    expect(result.estimatedCount).toBe(0);
    expect(result.unknownModelCount).toBe(0);
  });
});

describe('PRICING table', () => {
  it('exports both anthropic and openai providers', () => {
    expect(PRICING.anthropic).toBeDefined();
    expect(PRICING.openai).toBeDefined();
  });

  it('every Anthropic entry has both inputPerMillion and outputPerMillion', () => {
    for (const [model, pricing] of Object.entries(PRICING.anthropic)) {
      expect(pricing.inputPerMillion).toBeGreaterThan(0);
      expect(pricing.outputPerMillion).toBeGreaterThan(0);
      // Output is always more expensive than input for chat models
      expect(pricing.outputPerMillion, `${model} output should exceed input`).toBeGreaterThan(
        pricing.inputPerMillion,
      );
    }
  });
});
