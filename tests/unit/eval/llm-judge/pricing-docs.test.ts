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
import { MODEL_PRICING, PRICING_SOURCED_ON, PRICING_SOURCES, findPricing, pricedModels, supportedModelsSummary } from '../../../../src/eval/llm-judge/pricing.js';

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

  it('a retired model says so in its row, with the day it was found absent, and the guide names the day the table was read', () => {
    const rows = guideRows();
    for (const p of MODEL_PRICING) {
      const row = rows.find((r) => r.model === p.model)!;
      if (p.retired) expect(row.notes, p.model).toContain(`Retired ${p.retired}:`);
      else expect(row.notes.toLowerCase(), p.model).not.toContain('retired');
    }
    // The sentence that says when, not only a date somewhere in the page.
    expect(guide).toContain(`Read from the providers' own pages on ${PRICING_SOURCED_ON}: Anthropic's pricing page (platform.claude.com/docs/en/about-claude/pricing), OpenAI's (developers.openai.com/api/docs/pricing),`);
    expect(PRICING_SOURCES).toEqual({ anthropic: 'https://platform.claude.com/docs/en/about-claude/pricing', openai: 'https://developers.openai.com/api/docs/pricing' });
  });

  it('the two models OpenAI shut down on 2026-10-23 say so, and that a judge named on one fails there', () => {
    const rows = guideRows();
    for (const model of ['o4-mini', 'o3-mini']) {
      expect(findPricing(model)?.retired, model).toBe('2026-11-18');
      expect(rows.find((r) => r.model === model)!.notes, model).toBe("Retired 2026-11-18: absent from the provider's pricing page; OpenAI's deprecations page lists it shut down on 2026-10-23, so a judge named on it fails at OpenAI");
    }
  });

  it('the guide, the cost page, the reference and the changelog say, word for word, how a request is priced and when the pages were read', () => {
    const read = (path: string): string => readFileSync(resolve(__dirname, '..', '..', '..', '..', path), 'utf8').replace(/\r\n/g, '\n');
    const cost = read('docs/cost.md');
    const reference = read('docs/api-reference.md');
    const changelog = read('CHANGELOG.md');
    // The guide: the judge's caching, its sizes and its cap, a 12-hour write, the models not priced, a retirement date.
    expect(guide).toContain('The judge asks for no caching: Anthropic caches only what a request marks, and the judge marks nothing; GPT-5.6 and later, which write a request\'s prompt to the cache unasked and charge 1.25 times the input for it, are sent `prompt_cache_options` with `mode: "explicit"` and no breakpoint, which OpenAI\'s Chat Completions reference says uses no prompt caching.');
    expect(guide).toContain('Each request of a judge call is priced by its own size, and a call that asks twice costs the two requests priced one by one and added. Its cost cap prices a request at the higher rates wherever its input estimate (four characters a token), raised by 30%, is over the line');
    expect(guide).toContain('so it is priced at the base rates, and says so when the total is over it and its calls do not account for it.');
    expect(guide).toContain('a 12-hour write (2.5 times) is not priced, since nothing a trace carries that Iris reads splits the two.');
    expect(guide).toContain("Not priced: OpenAI's pro models (`gpt-5.5-pro`, `gpt-5.4-pro`, `gpt-5.2-pro`, `gpt-5-pro`, `o3-pro`), whose pages say they do not take Chat Completions, the endpoint the judge calls; `gpt-5.6-sol`, whose page gives a promotional price until 2026-11-30");
    expect(guideRows().find((r) => r.model === 'claude-sonnet-4-5')!.notes).toBe('Retires on the Claude API on 2026-11-30');
    // The cost page: a total's note and its condition, the one-model exception, a 12-hour write, the wrappers' writes, one rate from config.json.
    expect(cost).toContain('It is priced at the base rates, and when the total is over the line and the calls on the spans do not account for it, each under the line, `cost_estimate.notes` says the estimate may be low.');
    expect(cost).toContain('so each call is then priced on its own, and what `token_usage` records beyond those calls is priced as one more total, at the base rates, with a note that says so.');
    expect(cost).toContain('- **A 12-hour cache write** on OpenAI is priced as a 30-minute write (1.25 times the input price, where OpenAI charges 2.5 times): no field Iris reads splits the two.');
    expect(cost).toContain('The `@iris-eval/sdk` and Python wrappers record OpenAI\'s cache reads, not its writes (`cache_write_tokens`), so on GPT-5.6 and later, where a write costs 1.25 times the input, a trace they send prices its written tokens as input, and the notes do not say so.');
    expect(cost).toContain('- **A price from `config.json`** is one rate at every size.');
    // The reference names the day the table was read.
    expect(reference).toContain(`Any model in the pricing table (\`docs/llm-as-judge.md\`, read from both providers on ${PRICING_SOURCED_ON}); an unknown id is refused with the full list`);
    // The changelog: the lines, a request priced by its own size, the cap, the remainder, caching, the retired models and the lead.
    expect(changelog).toContain('Claude Haiku 5.5 over 100,000 prompt tokens, and OpenAI\'s models from GPT-5.4 over 272,000 input tokens, cost more, for the whole request.');
    expect(changelog).toContain('Each request of a judge call is priced by its own size, and a call that asks twice costs the two requests priced one by one and added; its cost cap prices a request at the higher rates wherever its input estimate, raised by 30%, is over the line');
    expect(changelog).toContain('a trace of one model with a call over the line is priced call by call, and what its `token_usage` records beyond those calls as one more total, with a note.');
    expect(changelog).toContain('The judge asks GPT-5.6 and later for no prompt caching (`prompt_cache_options` with `mode: "explicit"` and no breakpoint), so its requests write nothing to the cache');
    expect(changelog).toContain('a 12-hour write is priced as one, since nothing a trace carries that Iris reads splits the two.');
    expect(changelog).toContain('`gpt-5.6-sol`, whose price is a promotion until 2026-11-30');
    expect(changelog).toContain('`o4-mini` and `o3-mini`, gone from OpenAI\'s pricing page and shut down on 2026-10-23, are marked retired: a trace that recorded one is still priced at its last price, and a judge named on one fails at OpenAI.');
    expect(changelog).toContain("The judge tools' description now leads with each provider's four latest models: `claude-fable-5-2`, `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5`, and `gpt-6.2-astra`, `gpt-6.2-sol`, `gpt-6.1-terra` and `gpt-6-luna`.");
  });

  it("the cost page's example of a rule's message carries the table's date, as the message does", () => {
    const cost = readFileSync(resolve(__dirname, '..', '..', '..', '..', 'docs', 'cost.md'), 'utf8');
    expect(cost).toContain(`(estimated by Iris: 150,000 input and 10,000 output tokens at gpt-4o-mini list price as of ${PRICING_SOURCED_ON}; the trace reported no cost)`);
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

  it('the guide and the cost page state the two lines the table prices by, and the changelog names every model added on the day', () => {
    const cost = readFileSync(resolve(__dirname, '..', '..', '..', '..', 'docs', 'cost.md'), 'utf8');
    const changelog = readFileSync(resolve(__dirname, '..', '..', '..', '..', 'CHANGELOG.md'), 'utf8');
    const lines = [...new Set(MODEL_PRICING.flatMap((p) => (p.longContext ? [p.longContext.aboveInputTokens] : [])))].sort((a, b) => a - b);
    expect(lines).toEqual([100_000, 272_000]);
    expect(guide).toContain('Anthropic bills a request to Claude Haiku 5.5 whose prompt is over 100,000 tokens at higher rates, and OpenAI bills a request over 272,000 input tokens to GPT-5.4, GPT-5.5, GPT-5.6 or GPT-6 at twice the input and cache rates and 1.5 times the output');
    expect(cost).toContain('Claude Haiku 5.5 over 100,000 prompt tokens, and OpenAI\'s GPT-5.4, GPT-5.5, GPT-5.6 and GPT-6 over 272,000 input tokens (twice the input and cache rates, 1.5 times the output)');
    const entry = changelog.split('- **The judge and a trace\'s estimated cost price both providers\' current models, and a request by its size.**')[1]?.split('\n- **')[0];
    expect(entry, 'the changelog entry').toBeDefined();
    const added = ['claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5', 'gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.2', 'gpt-5.1', 'gpt-5-nano', 'gpt-4.1', 'o3'];
    for (const model of added) {
      expect(findPricing(model), model).not.toBeNull();
      expect(entry!, model).toContain(`\`${model}\``);
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

  it('the tools’ model sentence leads with each provider’s four latest models and never offers a retired one', () => {
    const s = supportedModelsSummary();
    for (const provider of ['anthropic', 'openai'] as const) {
      const lead = MODEL_PRICING.filter((p) => p.provider === provider && !p.retired).slice(0, 4).map((p) => p.model);
      expect(s).toContain(lead.join(' | '));
    }
    expect(s).toBe(
      'anthropic = claude-fable-5-2 | claude-opus-5-5 | claude-sonnet-5-5 | claude-haiku-5-5 (and earlier Claude models); openai = gpt-6.2-astra | gpt-6.2-sol | gpt-6.1-terra | gpt-6-luna (and earlier GPT models, and o3)',
    );
    for (const p of MODEL_PRICING.filter((m) => m.retired)) expect(s).not.toContain(p.model);
    expect(s).not.toContain('retired');
    expect(s.split(/\s+/).length).toBeLessThan(40);
  });
});
