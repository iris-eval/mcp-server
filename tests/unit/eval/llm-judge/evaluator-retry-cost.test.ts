import { describe, it, expect, vi, afterEach } from 'vitest';
import { evaluateWithLLMJudge } from '../../../../src/eval/llm-judge/evaluator.js';
import { estimateInputTokens } from '../../../../src/eval/llm-judge/client.js';
import { estimateCostUsd } from '../../../../src/eval/llm-judge/pricing.js';
import { getTemplate } from '../../../../src/eval/llm-judge/templates/index.js';

/*
 * The malformed-JSON retry and the money.
 *
 * When the judge's first reply did not parse, the retry's usage used to
 * OVERWRITE the first attempt's: the provider had billed both calls, and
 * `cost_usd` (surfaced by evaluate_with_llm_judge, stored on the eval
 * result, charted on the dashboard) reported roughly half of it. The
 * pre-flight cap check priced one call, so an eval estimated just under
 * the cap could bill nearly twice the cap the moment a retry ran — the
 * "hard ceiling" the docs promise was a ceiling on the first attempt only.
 */

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function anthropicReply(text: string, usage: { input: number; output: number }): Response {
  return new Response(
    JSON.stringify({
      id: 'msg',
      content: [{ type: 'text', text }],
      usage: { input_tokens: usage.input, output_tokens: usage.output },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('malformed-response retry — token and cost accounting', () => {
  it('reports and costs BOTH attempts, not just the retry', async () => {
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls++;
      return calls === 1
        ? anthropicReply('Not JSON at all, just prose', { input: 100, output: 40 })
        : anthropicReply('{"score":0.6,"passed":false,"rationale":"ok","dimensions":{}}', { input: 110, output: 30 });
    }) as typeof fetch;

    const res = await evaluateWithLLMJudge({
      output: 'x',
      template: 'accuracy',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'k',
    });

    expect(calls).toBe(2);
    expect(res.score).toBe(0.6);
    expect(res.inputTokens).toBe(210);
    expect(res.outputTokens).toBe(70);
    // haiku: 210/1M × $1 + 70/1M × $5 = 0.00021 + 0.00035
    expect(res.costUsd).toBe(estimateCostUsd('claude-haiku-4-5', 210, 70));
    expect(res.costUsd).toBe(0.00056);
  });

  it('a single well-formed attempt is costed exactly as before', async () => {
    global.fetch = vi.fn(async () =>
      anthropicReply('{"score":0.9,"passed":true,"rationale":"","dimensions":{}}', { input: 100, output: 30 }),
    ) as typeof fetch;

    const res = await evaluateWithLLMJudge({
      output: 'x',
      template: 'accuracy',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'k',
    });

    expect(res.inputTokens).toBe(100);
    expect(res.outputTokens).toBe(30);
    expect(res.costUsd).toBe(0.00025);
  });
});

describe('pre-flight cap — prices the retry too', () => {
  // Worst-case cost of ONE attempt, computed the way the evaluator does
  // (chars ÷ 4 for input, the full output cap billed). The nonce is fixed
  // length, so prompt lengths are stable across builds.
  function singleAttemptCost(model: string, output: string, maxOutputTokens: number): number {
    const template = getTemplate('accuracy');
    const system = template.buildSystem();
    const user = template.buildUser({ output });
    return estimateCostUsd(model, estimateInputTokens(system, user), maxOutputTokens)!;
  }

  it('refuses a cap that covers one attempt but not the retry', async () => {
    let called = false;
    global.fetch = vi.fn(async () => {
      called = true;
      return new Response();
    }) as typeof fetch;

    const model = 'claude-opus-4-7';
    const maxOutputTokens = 256;
    const one = singleAttemptCost(model, 'y', maxOutputTokens);
    // Old check: one attempt fits → call proceeds. New check: two attempts
    // (the retry re-sends the prompt plus a short suffix) do not fit.
    const cap = one * 1.5;

    await expect(
      evaluateWithLLMJudge({
        output: 'y',
        template: 'accuracy',
        provider: 'anthropic',
        model,
        apiKey: 'k',
        maxCostUsdPerEval: cap,
        maxOutputTokens,
      }),
    ).rejects.toThrow(/including one retry.*exceeds cap/);
    expect(called).toBe(false);
  });

  it('proceeds when the cap covers both attempts', async () => {
    global.fetch = vi.fn(async () =>
      anthropicReply('{"score":0.9,"passed":true,"rationale":"","dimensions":{}}', { input: 10, output: 5 }),
    ) as typeof fetch;

    const model = 'claude-opus-4-7';
    const maxOutputTokens = 256;
    const one = singleAttemptCost(model, 'y', maxOutputTokens);

    const res = await evaluateWithLLMJudge({
      output: 'y',
      template: 'accuracy',
      provider: 'anthropic',
      model,
      apiKey: 'k',
      maxCostUsdPerEval: one * 2.5,
      maxOutputTokens,
    });
    expect(res.score).toBe(0.9);
  });
});
