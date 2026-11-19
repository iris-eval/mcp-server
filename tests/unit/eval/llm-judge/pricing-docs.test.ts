/*
 * The guide's price table is held to the code (since the 2026-09-20 audit).
 *
 * Two tables of one fact drift: the cost estimator carried its own copy with
 * older ids from 0.3.1, and the guide listed claude-opus-4-7 at three times
 * its price for months. The code is the one table; the guide's rows are
 * parsed here and compared, price for price, and a retired model must say
 * so in its row. The contributor's correction (#478) is locked by value.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRICING } from '../../../../src/cost-estimator.js';
import { MODEL_PRICING, PRICING_SOURCED_ON, findPricing, pricedModels, supportedModelsSummary } from '../../../../src/eval/llm-judge/pricing.js';

const guide = readFileSync(resolve(__dirname, '..', '..', '..', '..', 'docs', 'llm-as-judge.md'), 'utf8');

/** The rows of the first markdown table whose header starts with "| Provider". */
function guideRows(): Array<{ provider: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: string; notes: string }> {
  const lines = guide.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\|\s*Provider\s*\|/.test(l));
  expect(start).toBeGreaterThan(-1);
  const rows: Array<{ provider: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: string; notes: string }> = [];
  for (let i = start + 2; i < lines.length && lines[i].startsWith('|'); i += 1) {
    const cells = lines[i].split('|').slice(1, -1).map((c) => c.trim());
    rows.push({ provider: cells[0], model: cells[1], input: Number(cells[2]), output: Number(cells[3]), cacheRead: Number(cells[4]), cacheWrite: Number(cells[5]), cacheWrite1h: cells[6], notes: cells[7] ?? '' });
  }
  return rows;
}

describe('the guide’s price table is the code’s', () => {
  it('lists every priced model with the same prices, and nothing the code does not price', () => {
    const rows = guideRows();
    expect(rows.map((r) => r.model).sort()).toEqual(pricedModels().slice().sort());
    for (const r of rows) {
      const p = findPricing(r.model)!;
      expect(p, r.model).not.toBeNull();
      expect(r.provider).toBe(p.provider);
      expect(r.input).toBeCloseTo(p.inputUsdPer1M, 6);
      expect(r.output).toBeCloseTo(p.outputUsdPer1M, 6);
      expect(r.cacheRead, `${r.model} cache read`).toBeCloseTo(p.cacheReadUsdPer1M, 6);
      expect(r.cacheWrite, `${r.model} cache write`).toBeCloseTo(p.cacheWriteUsdPer1M, 6);
      // A dash where the provider has no 1-hour write.
      if (p.cacheWrite1hUsdPer1M === undefined) expect(r.cacheWrite1h, `${r.model} 1h cache write`).toBe('—');
      else expect(Number(r.cacheWrite1h), `${r.model} 1h cache write`).toBeCloseTo(p.cacheWrite1hUsdPer1M, 6);
    }
  });

  it('a retired model says so in its row, and the guide names the day the table was read', () => {
    const rows = guideRows();
    for (const p of MODEL_PRICING) {
      const row = rows.find((r) => r.model === p.model)!;
      if (p.retired) expect(row.notes.toLowerCase(), p.model).toContain('retired');
      else expect(row.notes.toLowerCase(), p.model).not.toContain('retired');
    }
    expect(guide).toContain(PRICING_SOURCED_ON);
  });
});

describe('the one table', () => {
  it('claude-opus-4-7 is $5 in and $25 out — the contributor’s correction, locked by value', () => {
    expect(findPricing('claude-opus-4-7')).toMatchObject({ provider: 'anthropic', inputUsdPer1M: 5, outputUsdPer1M: 25 });
  });

  it('the cost estimator’s table derives from the judge’s: same ids, same prices', () => {
    const flat = Object.entries(PRICING).flatMap(([provider, models]) => Object.entries(models).map(([model, x]) => ({ provider, model, ...x })));
    expect(flat.map((f) => f.model).sort()).toEqual(pricedModels().slice().sort());
    for (const f of flat) {
      const p = findPricing(f.model)!;
      expect(f.provider).toBe(p.provider);
      expect(f.inputPerMillion).toBe(p.inputUsdPer1M);
      expect(f.outputPerMillion).toBe(p.outputUsdPer1M);
    }
  });

  it('every retired entry carries the date it was found absent, and o1-mini is one', () => {
    for (const p of MODEL_PRICING) if (p.retired) expect(p.retired).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(findPricing('o1-mini')?.retired).toBe('2026-09-20');
  });

  it('every model prices a cache read below its input, and a cache write at or above it', () => {
    for (const p of MODEL_PRICING) {
      expect(p.cacheReadUsdPer1M, p.model).toBeLessThan(p.inputUsdPer1M);
      expect(p.cacheWriteUsdPer1M, p.model).toBeGreaterThanOrEqual(p.inputUsdPer1M);
      // Anthropic's 5-minute write and OpenAI's 30-minute write (from GPT-5.6) are 1.25x the input; OpenAI's earlier models charge no write premium.
      const writes = p.provider === 'anthropic' || /^gpt-(5\.6|6)/.test(p.model);
      expect(p.cacheWriteUsdPer1M, p.model).toBeCloseTo(writes ? p.inputUsdPer1M * 1.25 : p.inputUsdPer1M, 9);
      // Anthropic's 1-hour write is 2x the input; OpenAI's 12-hour write is not priced.
      if (p.provider === 'anthropic') expect(p.cacheWrite1hUsdPer1M, p.model).toBeCloseTo(p.inputUsdPer1M * 2, 9);
      else expect(p.cacheWrite1hUsdPer1M, p.model).toBeUndefined();
    }
  });

  it("a request's size prices it as each provider says: Haiku 5.5 over 100,000 tokens, OpenAI from GPT-5.4 over 272,000", () => {
    const sized = MODEL_PRICING.filter((p) => p.longContext !== undefined).map((p) => p.model);
    expect(sized).toEqual(['claude-haiku-5-5', 'gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4']);
    // Anthropic's pricing page: Claude Haiku 5.5 over 100,000 prompt tokens.
    expect(findPricing('claude-haiku-5-5')!.longContext).toEqual({ aboveInputTokens: 100_000, inputUsdPer1M: 0.5, outputUsdPer1M: 2.5, cacheReadUsdPer1M: 0.05, cacheWriteUsdPer1M: 0.625, cacheWrite1hUsdPer1M: 1 });
    // OpenAI's model pages: over 272K input tokens, 2x input and cache, 1.5x output, for the full request.
    for (const p of MODEL_PRICING.filter((m) => m.provider === 'openai' && m.longContext !== undefined)) {
      const long = p.longContext!;
      expect(long.aboveInputTokens, p.model).toBe(272_000);
      expect(long.inputUsdPer1M, p.model).toBeCloseTo(p.inputUsdPer1M * 2, 9);
      expect(long.cacheReadUsdPer1M, p.model).toBeCloseTo(p.cacheReadUsdPer1M * 2, 9);
      expect(long.cacheWriteUsdPer1M, p.model).toBeCloseTo(p.cacheWriteUsdPer1M * 2, 9);
      expect(long.outputUsdPer1M, p.model).toBeCloseTo(p.outputUsdPer1M * 1.5, 9);
      expect(long.cacheWrite1hUsdPer1M, p.model).toBeUndefined();
    }
  });

  it("the guide's row for a model priced by size gives its rates over the line, and no other row speaks of a size", () => {
    const rows = guideRows();
    // Two decimals, as the table writes a price, unless that would round it (0.625 stays 0.625).
    const two = (x: number): string => (Number(x.toFixed(2)) === x ? x.toFixed(2) : String(x));
    for (const p of MODEL_PRICING) {
      const notes = rows.find((r) => r.model === p.model)!.notes;
      const long = p.longContext;
      if (long === undefined) {
        expect(notes, p.model).not.toMatch(/input tokens/);
        continue;
      }
      const expected = `Over ${long.aboveInputTokens.toLocaleString('en-US')} input tokens, the whole request: ${two(long.inputUsdPer1M)} / ${two(long.outputUsdPer1M)}; cache read ${two(long.cacheReadUsdPer1M)}, write ${two(long.cacheWriteUsdPer1M)}${long.cacheWrite1hUsdPer1M !== undefined ? `, 1h write ${two(long.cacheWrite1hUsdPer1M)}` : ''}`;
      expect(notes, p.model).toContain(expected);
    }
  });

  it('o1-mini is $1.10 in and $4.40 out, as OpenAI’s model page lists it — not its $3 / $12 launch price', () => {
    expect(findPricing('o1-mini')).toMatchObject({ provider: 'openai', inputUsdPer1M: 1.1, outputUsdPer1M: 4.4 });
  });

  it('the truthbase lists exactly the priced, non-retired models, in table order', () => {
    const claims = JSON.parse(readFileSync(resolve(__dirname, '..', '..', '..', '..', '.claims.json'), 'utf8')) as { llmJudgeTemplates: { supportedModels: string[] } };
    expect(claims.llmJudgeTemplates.supportedModels).toEqual(MODEL_PRICING.filter((p) => !p.retired).map((p) => p.model));
  });

  it('the tools’ model sentence leads with current models per provider and never a retired one', () => {
    const s = supportedModelsSummary();
    for (const provider of ['anthropic', 'openai'] as const) {
      const lead = MODEL_PRICING.filter((p) => p.provider === provider && !p.retired).slice(0, 3).map((p) => p.model);
      expect(s).toContain(lead.join(' | '));
    }
    expect(s).toContain('claude-fable-5-2 | claude-opus-5-5 | claude-sonnet-5-5');
    expect(s).toContain('gpt-6.2-astra | gpt-6.2-sol | gpt-6.1-terra');
    for (const p of MODEL_PRICING.filter((m) => m.retired)) expect(s).not.toContain(p.model);
    expect(s.split(/\s+/).length).toBeLessThan(40);
  });
});
