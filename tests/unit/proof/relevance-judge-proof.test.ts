/*
 * The relevance judge's proof set, and what can be measured of it without a
 * key (#649).
 *
 * The judge's own precision and recall need a keyed `npm run proof:judge`,
 * and until one runs they are pending. Three things are measurable here, on
 * every CI run:
 *
 *   1. The case file's rubric is the template's, verbatim: every rubric entry
 *      is made of whole lines of RELEVANCE_TEMPLATE's system prompt, so the
 *      labels were judged against the bar the judge is given.
 *   2. The worst case one relevance judgment can cost, per case, on the
 *      default proof models, under the evaluator's own two-attempt pre-check:
 *      every case fits the shipped per-call cap with room to spare.
 *   3. What the lexical answers_the_ask — the rule a deployment gets with no
 *      judge — does on the same cases. That is the gap the judge exists to
 *      close, and it is pinned here so the number the docs quote is this
 *      test's.
 */
import { describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJudgeCaseFile, materialiseCases } from '../../../proof/judge/lib/cases.js';
import { RELEVANCE_TEMPLATE } from '../../../src/eval/llm-judge/templates/index.js';
import { estimateCostUsd } from '../../../src/eval/llm-judge/pricing.js';
import { estimateInputTokens } from '../../../src/eval/llm-judge/client.js';
import { answersTheAsk } from '../../../src/eval/rules/relevance.js';
import { JUDGE_DEFAULT_COST_CAP_USD } from '../../../src/judge-enablement.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The evaluator's pre-check, as evaluator.ts computes it: both attempts, the full output cap billed. */
function worstCaseUsd(model: string, input: string, output: string): number {
  const system = RELEVANCE_TEMPLATE.buildSystem();
  const user = RELEVANCE_TEMPLATE.buildUser({ input, output });
  const strict = system + '\n\nIMPORTANT: your previous response was not valid JSON. Respond with ONLY the JSON object, no prefatory text, no code fences.';
  return (estimateCostUsd(model, estimateInputTokens(system, user), 512) ?? Infinity) + (estimateCostUsd(model, estimateInputTokens(strict, user), 256) ?? Infinity);
}

describe('relevance judge proof set', () => {
  it('every rubric entry is whole lines of the shipped system prompt', async () => {
    const file = await readJudgeCaseFile(repoRoot, 'relevance');
    const lines = RELEVANCE_TEMPLATE.buildSystem()
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 20);
    for (const [key, text] of Object.entries(file.rubric)) {
      if (key === 'source') continue;
      let rest = text;
      for (const line of lines) rest = rest.split(line).join('');
      expect(rest.trim(), `rubric.${key} holds text the template does not`).toBe('');
    }
  });

  it('every case fits the shipped per-call cost cap on the default proof models, with the worst case stated', async () => {
    const cases = materialiseCases(await readJudgeCaseFile(repoRoot, 'relevance'));
    const worst = { anthropic: 0, openai: 0 };
    for (const c of cases) {
      worst.anthropic = Math.max(worst.anthropic, worstCaseUsd('claude-haiku-4-5-20251001', c.input!, c.output));
      worst.openai = Math.max(worst.openai, worstCaseUsd('gpt-4o-mini', c.input!, c.output));
    }
    expect(worst.anthropic).toBeLessThan(JUDGE_DEFAULT_COST_CAP_USD);
    expect(worst.openai).toBeLessThan(JUDGE_DEFAULT_COST_CAP_USD);
    // The figures docs/llm-as-judge.md quotes, to four decimal places.
    expect(worst.anthropic.toFixed(4)).toBe('0.0059');
    expect(worst.openai.toFixed(4)).toBe('0.0008');
  });

  it('the lexical answers_the_ask on the same cases: the gap the judge exists to close', async () => {
    const cases = materialiseCases(await readJudgeCaseFile(repoRoot, 'relevance'));
    const c = { tp: 0, fp: 0, fn: 0, tn: 0, skipped: 0 };
    const missed: string[] = [];
    const wronglyFailed: string[] = [];
    for (const k of cases) {
      const r = answersTheAsk.evaluate({ input: k.input, output: k.output });
      if (r.skipped) c.skipped++;
      const fired = !r.skipped && r.passed === false;
      const bad = k.label === 'fail';
      if (fired && bad) c.tp++;
      else if (fired && !bad) {
        c.fp++;
        wronglyFailed.push(k.id);
      } else if (!fired && bad) {
        c.fn++;
        missed.push(k.id);
      } else c.tn++;
    }
    expect({ ...c, missed, wronglyFailed }).toMatchInlineSnapshot(`
      {
        "fn": 8,
        "fp": 2,
        "missed": [
          "relevance-violation-02",
          "relevance-violation-04",
          "relevance-violation-06",
          "relevance-violation-07",
          "relevance-violation-11",
          "relevance-violation-12",
          "relevance-injection-04",
          "relevance-injection-06",
        ],
        "skipped": 5,
        "tn": 16,
        "tp": 10,
        "wronglyFailed": [
          "relevance-adversarial-clean-01",
          "relevance-adversarial-clean-04",
        ],
      }
    `);
  });
});
