import { describe, it, expect, vi, afterEach } from 'vitest';
import { evaluateWithLLMJudge, worstCaseJudgeCostUsd } from '../../../../src/eval/llm-judge/evaluator.js';
import { verdictAnswer } from '../../../../src/eval/llm-judge/answer.js';
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

  function openaiReply(text: string, usage: Record<string, unknown>): Response {
    return new Response(JSON.stringify({ id: 'c', choices: [{ message: { content: text }, finish_reason: 'stop' }], usage }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  it.each([
    // Each request under the line, their sum over it: each is billed at the base rates.
    ['anthropic', 'claude-haiku-5-5', 60_000, 60_012],
    ['openai', 'gpt-5.4', 150_000, 150_012],
    ['openai', 'gpt-6-luna', 200_000, 200_012],
  ] as const)('%s %s: the two requests are priced one by one and added, never as one request of their summed size', async (provider, model, first, second) => {
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls++;
      const text = calls === 1 ? 'Not JSON at all, just prose' : '{"score":0.6,"passed":false,"rationale":"ok","dimensions":{}}';
      const tokens = calls === 1 ? { input: first, output: 300 } : { input: second, output: 200 };
      return provider === 'anthropic' ? anthropicReply(text, tokens) : openaiReply(text, { prompt_tokens: tokens.input, completion_tokens: tokens.output });
    }) as typeof fetch;
    const res = await evaluateWithLLMJudge({ output: 'x', template: 'accuracy', provider, model, apiKey: 'k', maxCostUsdPerEval: 1_000 });
    expect(calls).toBe(2);
    expect(res.inputTokens).toBe(first + second);
    const each = estimateCostUsd(model, first, 300)! + estimateCostUsd(model, second, 200)!;
    expect(res.costUsd).toBe(Math.round(each * 1_000_000) / 1_000_000);
    // Priced as one request, the sum would have taken the higher rates.
    expect(estimateCostUsd(model, first + second, 500)!).toBeGreaterThan(res.costUsd! * 1.9);
  });

  it("a reply's input read from the cache or written to it is priced at those rates", async () => {
    global.fetch = vi.fn(async () =>
      openaiReply('{"score":0.9,"passed":true,"rationale":"","dimensions":{}}', { prompt_tokens: 50_000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 10_000, cache_write_tokens: 20_000 } }),
    ) as typeof fetch;
    const res = await evaluateWithLLMJudge({ output: 'x', template: 'accuracy', provider: 'openai', model: 'gpt-6.2-astra', apiKey: 'k', maxCostUsdPerEval: 1_000 });
    // 20,000 plain × 8 + 10,000 read × 0.40 + 20,000 written × 10, and 100 out × 40 = $0.368
    expect(res.costUsd).toBe(0.368);
    expect(res.inputTokens).toBe(50_000);
  });
});

describe('pre-flight cap — near a line, the higher rates', () => {
  it("refuses a cap that the base rates fit but the higher ones do not, where the estimate raised by the margin is over the line", async () => {
    let called = false;
    global.fetch = vi.fn(async () => {
      called = true;
      return new Response();
    }) as typeof fetch;
    // About 80,000 tokens by the four-characters estimate: under 100,000, and over it raised by 30%.
    const output = 'word '.repeat(64_000);
    const worst = worstCaseJudgeCostUsd({ template: 'accuracy', model: 'claude-haiku-5-5', output })!;
    const template = getTemplate('accuracy');
    const answer = verdictAnswer(template.dimensions);
    const estimate = estimateInputTokens(template.buildSystem(), template.buildUser({ output }), answer);
    expect(estimate).toBeLessThan(100_000);
    expect(estimate * 1.3).toBeGreaterThan(100_000);
    const atBaseRates = estimateCostUsd('claude-haiku-5-5', estimate, 512)! * 2;
    expect(worst).toBeGreaterThan(atBaseRates * 4);
    await expect(
      evaluateWithLLMJudge({ output, template: 'accuracy', provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: 'k', maxCostUsdPerEval: atBaseRates * 2 }),
    ).rejects.toThrow(/exceeds cap/);
    expect(called).toBe(false);
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
    // The request carries the template's answer schema and the provider's instructions for it.
    return estimateCostUsd(model, estimateInputTokens(system, user, verdictAnswer(template.dimensions)), maxOutputTokens)!;
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
