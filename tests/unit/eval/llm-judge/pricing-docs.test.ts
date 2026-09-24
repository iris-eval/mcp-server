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
function guideRows(): Array<{ provider: string; model: string; input: number; output: number; notes: string }> {
  const lines = guide.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\|\s*Provider\s*\|/.test(l));
  expect(start).toBeGreaterThan(-1);
  const rows: Array<{ provider: string; model: string; input: number; output: number; notes: string }> = [];
  for (let i = start + 2; i < lines.length && lines[i].startsWith('|'); i += 1) {
    const cells = lines[i].split('|').slice(1, -1).map((c) => c.trim());
    rows.push({ provider: cells[0], model: cells[1], input: Number(cells[2]), output: Number(cells[3]), notes: cells[4] ?? '' });
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

  it('the tools’ model sentence leads with current models per provider and never a retired one', () => {
    const s = supportedModelsSummary();
    expect(s).toContain('claude-opus-5');
    expect(s).toContain('gpt-5');
    expect(s).not.toMatch(/o1-mini/);
    expect(s.split(/\s+/).length).toBeLessThan(40);
  });
});
