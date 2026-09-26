/*
 * The keyed composite-with-judge measurement (proof:judge), run without a
 * key on a stand-in judge, so the harness itself is proved on every CI run:
 * the engine it builds consults the judge on the composite cases that carry
 * an ask, the harness composer gates on the judgment exactly as the product's
 * composer does (a harness that dropped it would measure a composer the
 * product does not run), and the comparison names the verdicts that moved.
 *
 * The stand-in fails every output it is asked about, so every composite case
 * that carries an input and is not already failed must move to fail: that
 * includes the four off-task cases the shipped config lets through. The
 * judge's real numbers are the keyed run's, and pending until one runs.
 */
import { describe, expect, it } from 'vitest';
import { compareCompositeWithJudge } from '../../../proof/judge/run.js';
import { repoRoot } from '../../../proof/run.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { createRelevanceJudge } from '../../../src/eval/llm-judge/relevance-judge.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import type { LLMJudgeEvaluateParams, LLMJudgeEvaluationResult } from '../../../src/eval/llm-judge/evaluator.js';

describe('the composite with a relevance judge installed', () => {
  it('consults the judge, gates on its fail as the product does, and names every verdict that moved', async () => {
    const asked: string[] = [];
    const failEverything = async (p: LLMJudgeEvaluateParams): Promise<LLMJudgeEvaluationResult> => {
      asked.push(p.input ?? '');
      return { passed: false, score: 0, passThreshold: 0.6, rationale: 'stand-in', dimensions: {}, model: p.model, provider: p.provider, template: 'relevance', inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 };
    };
    const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    engine.setRelevanceJudge(createRelevanceJudge({ model: 'claude-haiku-4-5', apiKey: 'stand-in', evaluate: failEverything }));

    const c = await compareCompositeWithJudge(repoRoot, engine);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((a) => a.trim().length > 0)).toBe(true);
    // The off-task cases the shipped config lets through fail once a judge says they are off-task.
    for (const id of ['offtask-056', 'offtask-057', 'offtask-058', 'offtask-061']) expect(c.flipped.toFail).toContain(id);
    // A judge that only fails can move nothing to pass.
    expect(c.flipped.toPass).toEqual([]);
    // Missed blocks can only fall, false blocks only rise, on every split.
    for (const split of ['test', 'dev', 'realTranscripts'] as const) {
      expect(c.withJudge[split].missedBlock.k).toBeLessThanOrEqual(c.withoutJudge[split].missedBlock.k);
      expect(c.withJudge[split].falseBlock.k).toBeGreaterThanOrEqual(c.withoutJudge[split].falseBlock.k);
    }
  }, 240_000);
});
