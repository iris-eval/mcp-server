/*
 * The price of a model a trace recorded.
 *
 * A trace names its model the way its producer does: `gpt-4o-mini`, the
 * dated `gpt-4o-mini-2024-07-18` the API answers with, `openai/gpt-4o-mini`
 * from a router, `anthropic:claude-sonnet-4-5` from Pydantic AI. The lookup
 * is explicit and finite, in this order, and the first match wins:
 *
 *   1. pricing.models in config.json, on the id ignoring case, then on the
 *      id with one provider prefix removed;
 *   2. the built-in table (src/eval/llm-judge/pricing.ts), on the id
 *      ignoring case;
 *   3. the same, with one provider prefix removed (`openai/`, `openai:`,
 *      `anthropic/`, `anthropic:`), only when the prefix names the provider
 *      that prices the model;
 *   4. a dated snapshot listed in MODEL_SNAPSHOTS, mapped to the row the
 *      provider prices it as (with or without a prefix).
 *
 * Nothing else. No suffix is stripped by rule, no nearest name is taken:
 * a wrong price is worse than no price, because a rule or an alert would
 * act on it. An id that matches none of these is an unknown model, and the
 * trace says so rather than carrying a guess.
 */
import { MODEL_PRICING, MODEL_SNAPSHOTS, PRICING_SOURCED_ON, type PricingProvider } from '../eval/llm-judge/pricing.js';
import type { ConfiguredModelPrice } from '../types/config.js';

export interface PricingSettings {
  estimate: boolean;
  models: readonly ConfiguredModelPrice[];
  asOf?: string;
}

export interface PriceMatch {
  /** The id as the trace recorded it. */
  model: string;
  /** The table id it matched. */
  pricedAs: string;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  /** Null when the price came from config.json and it named none. */
  cacheReadUsdPer1M: number | null;
  cacheWriteUsdPer1M: number | null;
  source: 'iris' | 'config';
  asOf: string | null;
}

const DEFAULT_SETTINGS: PricingSettings = { estimate: true, models: [] };
let settings: PricingSettings = DEFAULT_SETTINGS;

/**
 * The deployment's pricing settings, set once from config.json by
 * loadConfig — the server and `iris-eval ingest` both load it, so a trace
 * is priced the same through every door. Undefined restores the defaults.
 */
export function setPricingSettings(next: PricingSettings | undefined): void {
  settings = next ? { estimate: next.estimate, models: [...next.models], ...(next.asOf !== undefined ? { asOf: next.asOf } : {}) } : DEFAULT_SETTINGS;
}

export function pricingSettings(): PricingSettings {
  return settings;
}

/** The provider prefixes a router or a framework writes before a model id, and the provider each names. */
export const PROVIDER_PREFIXES: ReadonlyArray<readonly [string, PricingProvider]> = [
  ['openai/', 'openai'],
  ['openai:', 'openai'],
  ['anthropic/', 'anthropic'],
  ['anthropic:', 'anthropic'],
];

function withoutPrefix(id: string): { id: string; provider: PricingProvider } | null {
  for (const [prefix, provider] of PROVIDER_PREFIXES) {
    if (id.startsWith(prefix) && id.length > prefix.length) return { id: id.slice(prefix.length), provider };
  }
  return null;
}

const BUILT_IN = new Map(MODEL_PRICING.map((p) => [p.model.toLowerCase(), p] as const));

function builtIn(id: string, provider: PricingProvider | undefined): (typeof MODEL_PRICING)[number] | null {
  const row = BUILT_IN.get(id) ?? BUILT_IN.get(MODEL_SNAPSHOTS[id] ?? '');
  if (!row) return null;
  return provider === undefined || row.provider === provider ? row : null;
}

/** The price of `model` under `using` (the deployment's settings by default), or null when no table prices it. */
export function priceModel(model: string, using: PricingSettings = settings): PriceMatch | null {
  const id = model.trim().toLowerCase();
  if (id === '') return null;
  const stripped = withoutPrefix(id);

  for (const candidate of stripped ? [id, stripped.id] : [id]) {
    const configured = using.models.find((m) => m.model.trim().toLowerCase() === candidate);
    if (configured) {
      return {
        model,
        pricedAs: configured.model,
        inputUsdPer1M: configured.inputUsdPer1M,
        outputUsdPer1M: configured.outputUsdPer1M,
        cacheReadUsdPer1M: configured.cacheReadUsdPer1M ?? null,
        cacheWriteUsdPer1M: configured.cacheWriteUsdPer1M ?? null,
        source: 'config',
        asOf: using.asOf ?? null,
      };
    }
  }

  const row = builtIn(id, undefined) ?? (stripped ? builtIn(stripped.id, stripped.provider) : null);
  if (!row) return null;
  return {
    model,
    pricedAs: row.model,
    inputUsdPer1M: row.inputUsdPer1M,
    outputUsdPer1M: row.outputUsdPer1M,
    cacheReadUsdPer1M: row.cacheReadUsdPer1M,
    cacheWriteUsdPer1M: row.cacheWriteUsdPer1M,
    source: 'iris',
    asOf: PRICING_SOURCED_ON,
  };
}
