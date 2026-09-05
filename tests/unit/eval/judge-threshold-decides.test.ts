/*
 * The judge's threshold decides, not the judge (arc 3, A3-4).
 *
 * Arc zero found this as a tier-A gap: `passed` was the model's own boolean
 * whenever it supplied one, and the template's documented threshold was a
 * fallback the product rarely reached. A judge could return `score: 0.2`
 * with `passed: true` and be believed — a scoring rubric whose score did
 * not decide anything, which is the same defect as a verdict whose score
 * term is inert.
 *
 * No provider is called here: the client is mocked, so this runs offline
 * and on every machine. What it locks is the arithmetic, which is the part
 * a user has to be able to trust without a key.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const callLLMJudge = vi.fn();
vi.mock('../../../src/eval/llm-judge/client.js', () => ({
  callLLMJudge: (...args: unknown[]) => callLLMJudge(...args) as unknown,
  // The real one counts characters; the count does not matter here, only
  // that the cost cap has a number to work with.
  estimateInputTokens: () => 100,
  LLMJudgeError: class extends Error {},
}));

const { evaluateWithLLMJudge } = await import('../../../src/eval/llm-judge/evaluator.js');

/** One judge reply. `passed` is what the MODEL claims; omit it to say nothing. */
function reply(score: number, passed?: boolean): void {
  callLLMJudge.mockResolvedValueOnce({
    content: JSON.stringify({ score, rationale: 'because', dimensions: { a: score }, ...(passed === undefined ? {} : { passed }) }),
    inputTokens: 10,
    outputTokens: 10,
    latencyMs: 1,
    rawProviderResponseId: 'resp-1',
  });
}

const run = async (): ReturnType<typeof evaluateWithLLMJudge> =>
  evaluateWithLLMJudge({
    template: 'accuracy',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    apiKey: 'test-key-not-used',
    output: 'an answer',
    input: 'a question',
  });

describe('the threshold decides', () => {
  beforeEach(() => callLLMJudge.mockReset());

  it('a low score with the model claiming pass is a FAIL, and says they disagreed', async () => {
    reply(0.2, true);
    const r = await run();
    expect(r.score).toBe(0.2);
    expect(r.passed).toBe(false);
    expect(r.selfReportedPass).toBe(true);
    expect(r.disagreement).toBe(true);
    expect(r.score).toBeLessThan(r.passThreshold);
  });

  it('a high score with the model claiming fail is a PASS, and says they disagreed', async () => {
    reply(0.95, false);
    const r = await run();
    expect(r.passed).toBe(true);
    expect(r.selfReportedPass).toBe(false);
    expect(r.disagreement).toBe(true);
  });

  it('when they agree, nothing is flagged', async () => {
    reply(0.95, true);
    const r = await run();
    expect(r.passed).toBe(true);
    expect(r.selfReportedPass).toBe(true);
    expect(r.disagreement).toBeUndefined();
  });

  it('a model that says nothing about passing is not treated as having said anything', async () => {
    reply(0.95);
    const r = await run();
    expect(r.passed).toBe(true);
    expect(r.selfReportedPass).toBeUndefined();
    expect(r.disagreement).toBeUndefined();
  });

  it('the threshold travels with the verdict, so the arithmetic is checkable', async () => {
    reply(0.71);
    const r = await run();
    expect(r.passThreshold).toBeGreaterThan(0);
    expect(r.passed).toBe(r.score >= r.passThreshold);
  });

  it('a score exactly at the threshold passes — the comparison is inclusive and stated', async () => {
    reply(0.7);
    const r = await run();
    expect(r.passThreshold).toBe(0.7);
    expect(r.passed).toBe(true);
  });
});
