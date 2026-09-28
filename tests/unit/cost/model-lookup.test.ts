/*
 * The model-id normaliser behind a trace's estimated cost (#702).
 *
 * Every accepted spelling is listed with the row it must price as, and every
 * near miss with the reason it must NOT: a wrong price is worse than none,
 * because a budget rule and a cost alert act on it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { priceModel, setPricingSettings, PROVIDER_PREFIXES } from '../../../src/cost/model-lookup.js';
import { MODEL_PRICING, MODEL_SNAPSHOTS, PRICING_SOURCED_ON, findPricing } from '../../../src/eval/llm-judge/pricing.js';

afterEach(() => setPricingSettings(undefined));

describe('priceModel — the spellings that price', () => {
  const ACCEPTED: Array<[string, string]> = [
    // exact table ids
    ['gpt-4o-mini', 'gpt-4o-mini'],
    ['claude-sonnet-5', 'claude-sonnet-5'],
    ['claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001'],
    // case and surrounding space
    ['GPT-4o-mini', 'gpt-4o-mini'],
    ['  gpt-4o  ', 'gpt-4o'],
    // dated snapshots the provider prices as the row
    ['gpt-4o-mini-2024-07-18', 'gpt-4o-mini'],
    ['gpt-4o-2024-08-06', 'gpt-4o'],
    ['gpt-4o-2024-11-20', 'gpt-4o'],
    ['gpt-5-2025-08-07', 'gpt-5'],
    ['gpt-5-mini-2025-08-07', 'gpt-5-mini'],
    ['gpt-4.1-mini-2025-04-14', 'gpt-4.1-mini'],
    ['o4-mini-2025-04-16', 'o4-mini'],
    ['o3-mini-2025-01-31', 'o3-mini'],
    ['o1-mini-2024-09-12', 'o1-mini'],
    ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'],
    ['claude-opus-4-5-20251101', 'claude-opus-4-5'],
    // a provider prefix naming the provider that prices it (routers, LiteLLM, Pydantic AI)
    ['openai/gpt-4o-mini', 'gpt-4o-mini'],
    ['openai:gpt-4o', 'gpt-4o'],
    ['anthropic/claude-sonnet-5', 'claude-sonnet-5'],
    ['anthropic:claude-opus-5-5', 'claude-opus-5-5'],
    // prefix and snapshot together
    ['openai/gpt-4o-mini-2024-07-18', 'gpt-4o-mini'],
    ['anthropic:claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'],
  ];
  for (const [id, row] of ACCEPTED) {
    it(`${JSON.stringify(id)} prices as ${row}`, () => {
      const match = priceModel(id);
      expect(match).not.toBeNull();
      const want = findPricing(row)!;
      expect(match).toEqual({ model: id, pricedAs: row, inputUsdPer1M: want.inputUsdPer1M, outputUsdPer1M: want.outputUsdPer1M, cacheReadUsdPer1M: want.cacheReadUsdPer1M, cacheWriteUsdPer1M: want.cacheWriteUsdPer1M, source: 'iris', asOf: PRICING_SOURCED_ON });
    });
  }
});

describe('priceModel — the near misses that must not price', () => {
  const REFUSED: Array<[string, string]> = [
    ['gpt-4o-2024-05-13', 'a gpt-4o snapshot the provider priced at $5 / $15, twice gpt-4o'],
    ['gpt-4o-mini-2099-01-01', 'a snapshot nobody has checked is not guessed from its prefix'],
    ['ft:gpt-4o-mini-2024-07-18:acme::abc123', 'a fine-tuned model has its own price'],
    ['gpt-4o-mini-search-preview', 'a different model that starts with a priced id'],
    ['gpt-4', 'a shorter id is a different model'],
    ['gpt-4o-mini-audio', 'a suffix is never stripped'],
    ['claude-sonnet-4-5@20250929', 'a Google Cloud id: that platform sets its own price'],
    ['anthropic.claude-sonnet-4-5-20250929-v1:0', 'an Amazon Bedrock id: that platform sets its own price'],
    ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'a Bedrock regional id'],
    ['anthropic/gpt-4o', 'a prefix that names the wrong provider'],
    ['openai/claude-sonnet-5', 'a prefix that names the wrong provider'],
    ['azure/gpt-4o', 'a prefix Iris does not read: Azure deployments are priced by Azure'],
    ['openai/', 'a prefix with nothing after it'],
    ['gemini-2.5-flash', 'a provider the built-in table does not price'],
    ['', 'nothing'],
    ['   ', 'only space'],
  ];
  for (const [id, why] of REFUSED) {
    it(`${JSON.stringify(id)} is unknown — ${why}`, () => {
      expect(priceModel(id)).toBeNull();
    });
  }
});

describe('the snapshot table', () => {
  it('maps only to rows that exist, from ids that are not rows themselves, all in lower case', () => {
    for (const [snapshot, row] of Object.entries(MODEL_SNAPSHOTS)) {
      expect(findPricing(row), `${snapshot} → ${row}`).not.toBeNull();
      expect(findPricing(snapshot), snapshot).toBeNull();
      expect(snapshot).toBe(snapshot.toLowerCase());
      // A snapshot is the row's id plus a date: never a different model under a similar name.
      expect(snapshot.startsWith(`${row}-`), `${snapshot} extends ${row}`).toBe(true);
      expect(snapshot.slice(row.length + 1)).toMatch(/^(\d{4}-\d{2}-\d{2}|\d{8})$/);
    }
  });

  it('every prefix names a provider the built-in table prices', () => {
    const providers = new Set(MODEL_PRICING.map((p) => p.provider));
    for (const [, provider] of PROVIDER_PREFIXES) expect(providers.has(provider)).toBe(true);
  });
});

describe('pricing.models in config.json', () => {
  it('prices a model the built-in table does not, dated by pricing.asOf', () => {
    setPricingSettings({ estimate: true, models: [{ model: 'My-Azure-GPT4o', inputUsdPer1M: 2.75, outputUsdPer1M: 11 }], asOf: '2026-09-01' });
    expect(priceModel('my-azure-gpt4o')).toEqual({ model: 'my-azure-gpt4o', pricedAs: 'My-Azure-GPT4o', inputUsdPer1M: 2.75, outputUsdPer1M: 11, cacheReadUsdPer1M: null, cacheWriteUsdPer1M: null, source: 'config', asOf: '2026-09-01' });
  });

  it('wins over the built-in row for the same id, with or without a provider prefix; undated when asOf is unset', () => {
    setPricingSettings({ estimate: true, models: [{ model: 'gpt-4o-mini', inputUsdPer1M: 0.1, outputUsdPer1M: 0.4 }] });
    expect(priceModel('gpt-4o-mini')).toMatchObject({ source: 'config', inputUsdPer1M: 0.1, asOf: null });
    expect(priceModel('openai/gpt-4o-mini')).toMatchObject({ source: 'config', inputUsdPer1M: 0.1 });
    // A snapshot the config did not name still prices from the built-in table: config entries are exact ids.
    expect(priceModel('gpt-4o-mini-2024-07-18')).toMatchObject({ source: 'iris', inputUsdPer1M: 0.15 });
  });

  it('an explicit settings argument is read instead of the deployment’s', () => {
    setPricingSettings({ estimate: true, models: [{ model: 'x', inputUsdPer1M: 1, outputUsdPer1M: 1 }] });
    expect(priceModel('x', { estimate: true, models: [] })).toBeNull();
    expect(priceModel('x')).not.toBeNull();
  });
});

describe('docs/cost.md is held to the code', () => {
  const doc = readFileSync(resolve(__dirname, '..', '..', '..', 'docs', 'cost.md'), 'utf8');

  it('its snapshot table is MODEL_SNAPSHOTS, row for row', () => {
    const rows = [...doc.matchAll(/^\| `([^`]+)` \| `([^`]+)` \|\r?$/gm)].map((m) => [m[1], m[2]]);
    expect(Object.fromEntries(rows)).toEqual(MODEL_SNAPSHOTS);
    expect(rows).toHaveLength(Object.keys(MODEL_SNAPSHOTS).length);
  });

  it('names the date the built-in table was read', () => {
    expect(doc).toContain(`on **${PRICING_SOURCED_ON}**`);
  });
});
