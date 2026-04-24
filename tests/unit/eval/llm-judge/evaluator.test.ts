import { describe, it, expect, vi, afterEach } from 'vitest';
import { evaluateWithLLMJudge } from '../../../../src/eval/llm-judge/evaluator.js';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function mockAnthropicJSON(text: string, usage = { input: 100, output: 30 }) {
  global.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          id: 'msg_mock',
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
          usage: { input_tokens: usage.input, output_tokens: usage.output },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  ) as typeof fetch;
}

describe('evaluateWithLLMJudge', () => {
  it('parses a well-formed judge response', async () => {
    mockAnthropicJSON(
      '{"score":0.84,"passed":true,"rationale":"Output is accurate and specific","dimensions":{"factual_claims":0.9,"citations":1.0,"internal_consistency":0.8}}',
    );

    const res = await evaluateWithLLMJudge({
      output: 'The sky is blue.',
      template: 'accuracy',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'k',
    });

    expect(res.score).toBe(0.84);
    expect(res.passed).toBe(true);
    expect(res.rationale).toContain('accurate');
    expect(res.dimensions.factual_claims).toBe(0.9);
    expect(res.model).toBe('claude-haiku-4-5');
    expect(res.provider).toBe('anthropic');
    expect(res.template).toBe('accuracy');
    expect(res.inputTokens).toBe(100);
    expect(res.outputTokens).toBe(30);
    // 100/1M * 1 + 30/1M * 5 = 0.0001 + 0.00015 = 0.00025
    expect(res.costUsd).toBe(0.00025);
  });

  it('derives passed from score+threshold when judge omits passed field', async () => {
    // safety template has passThreshold=0.9
    mockAnthropicJSON('{"score":0.95,"rationale":"safe","dimensions":{}}');
    const high = await evaluateWithLLMJudge({
      output: 'Be nice',
      template: 'safety',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'k',
    });
    expect(high.passed).toBe(true);

    mockAnthropicJSON('{"score":0.5,"rationale":"borderline","dimensions":{}}');
    const low = await evaluateWithLLMJudge({
      output: 'Suspicious',
      template: 'safety',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'k',
    });
    expect(low.passed).toBe(false);
  });

  it('strips code-fence + prose wrappers around the JSON', async () => {
    mockAnthropicJSON(
      'Here is the evaluation:\n```json\n{"score":0.7,"passed":true,"rationale":"ok","dimensions":{}}\n```\nDone.',
    );
    const res = await evaluateWithLLMJudge({
      output: 'foo',
      template: 'helpfulness',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'k',
    });
    expect(res.score).toBe(0.7);
  });

  it('refuses unknown models upfront (no fetch)', async () => {
    let called = false;
    global.fetch = vi.fn(async () => {
      called = true;
      return new Response();
    }) as typeof fetch;

    await expect(
      evaluateWithLLMJudge({
        output: 'x',
        template: 'accuracy',
        provider: 'anthropic',
        model: 'claude-nonexistent-9000',
        apiKey: 'k',
      }),
    ).rejects.toThrow(/Unknown model/);
    expect(called).toBe(false);
  });

  it('refuses when pessimistic cost estimate exceeds cap', async () => {
    let called = false;
    global.fetch = vi.fn(async () => {
      called = true;
      return new Response();
    }) as typeof fetch;

    await expect(
      evaluateWithLLMJudge({
        output: 'y',
        template: 'accuracy',
        provider: 'anthropic',
        model: 'claude-opus-4-7', // expensive
        apiKey: 'k',
        maxCostUsdPerEval: 0.00001, // impossibly low cap
        maxOutputTokens: 2000,
      }),
    ).rejects.toThrow(/exceeds cap/);
    expect(called).toBe(false);
  });

  it('correctness template requires expected', async () => {
    mockAnthropicJSON('{"score":0.9,"passed":true,"rationale":"","dimensions":{}}');
    await expect(
      evaluateWithLLMJudge({
        output: 'yes',
        template: 'correctness',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        apiKey: 'k',
        // missing expected
      }),
    ).rejects.toThrow(/correctness template requires `expected`/);
  });

  it('faithfulness template requires sourceMaterial', async () => {
    mockAnthropicJSON('{"score":0.9,"passed":true,"rationale":"","dimensions":{}}');
    await expect(
      evaluateWithLLMJudge({
        output: 'RAG answer',
        template: 'faithfulness',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        apiKey: 'k',
        // missing sourceMaterial
      }),
    ).rejects.toThrow(/faithfulness template requires `sourceMaterial`/);
  });

  it('retries once on malformed response + succeeds', async () => {
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls++;
      const text = calls === 1 ? 'Not JSON at all, just prose' : '{"score":0.6,"passed":false,"rationale":"ok","dimensions":{}}';
      return new Response(
        JSON.stringify({
          id: 'm',
          content: [{ type: 'text', text }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
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
  });

  it('throws after second malformed response', async () => {
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls++;
      return new Response(
        JSON.stringify({
          id: 'm',
          content: [{ type: 'text', text: 'never json' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    await expect(
      evaluateWithLLMJudge({
        output: 'x',
        template: 'accuracy',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        apiKey: 'k',
      }),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
    expect(calls).toBe(2);
  });

  it('rejects out-of-[0..1] scores as malformed', async () => {
    mockAnthropicJSON('{"score":1.5,"passed":true,"rationale":"","dimensions":{}}');
    await expect(
      evaluateWithLLMJudge({
        output: 'x',
        template: 'accuracy',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        apiKey: 'k',
      }),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
  });
});
