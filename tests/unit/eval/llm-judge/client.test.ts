import { describe, it, expect, vi, afterEach } from 'vitest';
import { callLLMJudge, LLMJudgeError, estimateInputTokens } from '../../../../src/eval/llm-judge/client.js';

// Mock the global fetch so tests never hit the real providers.
const originalFetch = global.fetch;

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  global.fetch = vi.fn(impl) as typeof fetch;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('LLM judge client', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  describe('Anthropic', () => {
    it('calls the /messages endpoint with correct headers + body', async () => {
      let capturedUrl = '';
      let capturedInit: RequestInit = {};
      mockFetch(async (url, init) => {
        capturedUrl = url;
        capturedInit = init;
        return jsonResponse({
          id: 'msg_abc',
          content: [{ type: 'text', text: '{"score":0.85,"passed":true,"rationale":"Good"}' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 120, output_tokens: 42 },
        });
      });

      const res = await callLLMJudge({
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        systemPrompt: 'You are a judge',
        userPrompt: 'Grade this',
        maxOutputTokens: 256,
        temperature: 0,
        apiKey: 'sk-ant-test',
      });

      expect(capturedUrl).toBe('https://api.anthropic.com/v1/messages');
      const headers = capturedInit.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('sk-ant-test');
      expect(headers['anthropic-version']).toBe('2023-06-01');
      const body = JSON.parse(capturedInit.body as string);
      expect(body.model).toBe('claude-haiku-4-5');
      expect(body.system).toBe('You are a judge');
      expect(body.messages).toEqual([{ role: 'user', content: 'Grade this' }]);

      expect(res.content).toContain('score');
      expect(res.inputTokens).toBe(120);
      expect(res.outputTokens).toBe(42);
      expect(res.stopReason).toBe('end_turn');
      expect(res.latencyMs).toBeGreaterThanOrEqual(0);
      expect(res.rawProviderResponseId).toBe('msg_abc');
    });

    it('throws auth error on 401', async () => {
      mockFetch(async () => new Response('invalid key', { status: 401 }));
      await expect(
        callLLMJudge({
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          systemPrompt: '',
          userPrompt: '',
          maxOutputTokens: 10,
          temperature: 0,
          apiKey: 'bad',
        }),
      ).rejects.toMatchObject({ kind: 'auth', statusCode: 401 });
    });

    it('retries once on 429 + succeeds', async () => {
      let calls = 0;
      mockFetch(async () => {
        calls++;
        if (calls === 1) {
          return new Response('rate limited', {
            status: 429,
            headers: { 'retry-after': '0' }, // immediate retry
          });
        }
        return jsonResponse({
          id: 'msg_retry',
          content: [{ type: 'text', text: '{"score":0.5,"passed":false,"rationale":"x"}' }],
          usage: { input_tokens: 5, output_tokens: 5 },
        });
      });

      const res = await callLLMJudge({
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        systemPrompt: '',
        userPrompt: 'x',
        maxOutputTokens: 10,
        temperature: 0,
        apiKey: 'k',
      });
      expect(calls).toBe(2);
      expect(res.content).toContain('score');
    });

    it('propagates 429 on second attempt after retry', async () => {
      let calls = 0;
      mockFetch(async () => {
        calls++;
        return new Response('rate limited', {
          status: 429,
          headers: { 'retry-after': '0' },
        });
      });

      await expect(
        callLLMJudge({
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          systemPrompt: '',
          userPrompt: 'x',
          maxOutputTokens: 10,
          temperature: 0,
          apiKey: 'k',
        }),
      ).rejects.toMatchObject({ kind: 'rate_limit' });
      expect(calls).toBe(2);
    });

    it('surfaces malformed response when no text content block', async () => {
      mockFetch(async () =>
        jsonResponse({
          id: 'msg_empty',
          content: [{ type: 'tool_use' }],
          usage: { input_tokens: 1, output_tokens: 0 },
        }),
      );
      await expect(
        callLLMJudge({
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          systemPrompt: '',
          userPrompt: 'x',
          maxOutputTokens: 10,
          temperature: 0,
          apiKey: 'k',
        }),
      ).rejects.toMatchObject({ kind: 'malformed_response' });
    });
  });

  describe('OpenAI', () => {
    it('calls /chat/completions with Bearer auth + correct body', async () => {
      let capturedUrl = '';
      let capturedInit: RequestInit = {};
      mockFetch(async (url, init) => {
        capturedUrl = url;
        capturedInit = init;
        return jsonResponse({
          id: 'chatcmpl-1',
          choices: [{ message: { content: '{"score":0.9,"passed":true,"rationale":"y"}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 50, completion_tokens: 25 },
        });
      });

      const res = await callLLMJudge({
        provider: 'openai',
        model: 'gpt-4o-mini',
        systemPrompt: 'judge',
        userPrompt: 'score it',
        maxOutputTokens: 100,
        temperature: 0,
        apiKey: 'sk-openai',
      });

      expect(capturedUrl).toBe('https://api.openai.com/v1/chat/completions');
      const headers = capturedInit.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer sk-openai');
      const body = JSON.parse(capturedInit.body as string);
      expect(body.model).toBe('gpt-4o-mini');
      expect(body.messages[0]).toEqual({ role: 'system', content: 'judge' });
      expect(body.messages[1]).toEqual({ role: 'user', content: 'score it' });

      expect(res.inputTokens).toBe(50);
      expect(res.outputTokens).toBe(25);
      expect(res.stopReason).toBe('stop');
      expect(res.rawProviderResponseId).toBe('chatcmpl-1');
    });

    it('throws server_error on 503', async () => {
      mockFetch(async () => new Response('upstream down', { status: 503 }));
      await expect(
        callLLMJudge({
          provider: 'openai',
          model: 'gpt-4o-mini',
          systemPrompt: '',
          userPrompt: '',
          maxOutputTokens: 10,
          temperature: 0,
          apiKey: 'k',
        }),
      ).rejects.toMatchObject({ kind: 'server_error', statusCode: 503 });
    });
  });

  describe('input-token estimate + guard', () => {
    it('estimates ~4 chars per token', () => {
      expect(estimateInputTokens('', '')).toBe(0);
      expect(estimateInputTokens('a'.repeat(40), '')).toBe(10);
      expect(estimateInputTokens('a'.repeat(100), 'b'.repeat(100))).toBe(50);
    });

    it('rejects prompts over maxInputTokensEstimate before fetch', async () => {
      let called = false;
      mockFetch(async () => {
        called = true;
        return jsonResponse({});
      });
      await expect(
        callLLMJudge({
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          systemPrompt: 'a'.repeat(4000), // ~1000 tokens
          userPrompt: 'b'.repeat(4000),
          maxOutputTokens: 10,
          temperature: 0,
          apiKey: 'k',
          maxInputTokensEstimate: 500,
        }),
      ).rejects.toMatchObject({ kind: 'bad_request' });
      expect(called).toBe(false);
    });
  });

  describe('LLMJudgeError class', () => {
    it('is instanceof Error + preserves fields', () => {
      const e = new LLMJudgeError('boom', 'server_error', 502, 30);
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe('LLMJudgeError');
      expect(e.kind).toBe('server_error');
      expect(e.statusCode).toBe(502);
      expect(e.retryAfterSeconds).toBe(30);
    });
  });
});
