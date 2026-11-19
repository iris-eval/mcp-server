/*
 * A temperature is sent only to a model that takes one (#1078).
 *
 * Anthropic answers a `temperature` other than the default with a 400 on
 * Claude 4.7 and later models, under the API version Iris sends as well (its
 * model deprecations page), and OpenAI's reasoning models take none. The
 * judge sent every Claude model the call's temperature, 0 unless set, so a
 * call on any Claude model since 4.7 failed. No provider is called here: each
 * request is read as the provider would read it, and each reply is a
 * stand-in in the provider's own shape.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ANTHROPIC_TEMPERATURE_MODELS, callLLMJudge, takesTemperature, type LLMJudgeRequest, type LLMProvider } from '../../../../src/eval/llm-judge/client.js';
import { pricedModels } from '../../../../src/eval/llm-judge/pricing.js';
import { createRelevanceJudge } from '../../../../src/eval/llm-judge/relevance-judge.js';
import { EvalEngine } from '../../../../src/eval/engine.js';
import { verifyCitations } from '../../../../src/eval/citation-verify/verifier.js';
import { __clearCitationCacheForTests, __setDnsLookupForTests } from '../../../../src/eval/citation-verify/resolve.js';
import { WARNING_CODE_CATALOGUE } from '../../../../src/tools/errors.js';
import { SqliteAdapter } from '../../../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../../../src/server.js';
import { defaultConfig } from '../../../../src/config/defaults.js';

const root = resolve(__dirname, '../../../..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf-8').replace(/\r\n/g, '\n');

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  __clearCitationCacheForTests();
  __setDnsLookupForTests(null);
});

const VERDICT = '{"score":0.8,"passed":true,"rationale":"r","dimensions":{"factual_claims":0.8,"citations":1,"internal_consistency":0.9}}';

/** Every request a call sends, by its body; each reply in its provider's own shape, with the text given. */
function provider(text: string): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://api.anthropic.com/')) {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ id: 'm', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } });
    }
    if (url.startsWith('https://api.openai.com/')) {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ id: 'c', choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    }
    // A cited source, for verify_citations.
    return new Response('The retry limit is five attempts.', { headers: { 'content-type': 'text/plain' } });
  }) as unknown as typeof fetch;
  return bodies;
}

const request = (provider: LLMProvider, model: string, temperature: number): LLMJudgeRequest => ({
  provider,
  model,
  systemPrompt: 'system',
  userPrompt: 'user',
  maxOutputTokens: 512,
  temperature,
  apiKey: 'k',
});

/** The generation in a Claude model's id: claude-opus-4-8 is 4.8, claude-sonnet-5 is 5, and a dated id is its model's. */
function generation(model: string): number {
  const m = /^claude-[a-z]+-(\d+)(?:-(\d))?(?:-\d{8})?$/.exec(model);
  if (m === null) throw new Error(`not a Claude model id this test can read: ${model}`);
  return Number(m[1]) + Number(m[2] ?? 0) / 10;
}

describe('the request each model is sent', () => {
  it.each(pricedModels('anthropic'))('the Claude model %s, priced, is sent the temperature only when it is a model before 4.7', async (model) => {
    const bodies = provider(VERDICT);
    await callLLMJudge(request('anthropic', model, 0.3));
    expect(bodies).toHaveLength(1);
    if (generation(model) < 4.7) expect(bodies[0].temperature).toBe(0.3);
    else expect(bodies[0]).not.toHaveProperty('temperature');
  });

  it('the Claude models listed as taking a temperature are models Iris prices, each before 4.7', () => {
    expect(ANTHROPIC_TEMPERATURE_MODELS.size).toBeGreaterThan(0);
    for (const model of ANTHROPIC_TEMPERATURE_MODELS) {
      expect(pricedModels('anthropic'), model).toContain(model);
      expect(generation(model), model).toBeLessThan(4.7);
    }
  });

  it('a Claude model not listed is sent none, the default of every Claude model since 4.7', async () => {
    const bodies = provider(VERDICT);
    await callLLMJudge(request('anthropic', 'claude-opus-6', 0));
    expect(bodies[0]).not.toHaveProperty('temperature');
    expect(takesTemperature('anthropic', 'claude-opus-6')).toBe(false);
  });

  it.each([
    ...pricedModels('anthropic').map((m) => ['anthropic', m] as const),
    ...pricedModels('openai').map((m) => ['openai', m] as const),
    // Not listed: a Claude model is sent none, and an OpenAI model is asked as gpt-4o is.
    ['anthropic', 'claude-opus-6'] as const,
    ['openai', 'gpt-unlisted'] as const,
  ])(
    '%s %s: what takesTemperature says is what the request carries',
    async (p, model) => {
      const bodies = provider(VERDICT);
      await callLLMJudge(request(p, model, 0.3));
      expect('temperature' in bodies[0]).toBe(takesTemperature(p, model));
    },
  );
});

describe('the callers that set a temperature themselves', () => {
  it('the relevance judge on a Claude model since 4.7 is sent none, and its judgment stands', async () => {
    const bodies = provider('{"score":0.9,"passed":true,"rationale":"r","dimensions":{"addresses_request":0.9,"on_subject":0.9,"specific_to_request":0.9}}');
    const engine = new EvalEngine();
    engine.setRelevanceJudge(createRelevanceJudge({ model: 'claude-sonnet-5', apiKey: 'sk-ant-test' }));
    const r = await engine.evaluate('relevance', { input: 'How can I make my laptop battery last longer?', output: 'Dim the screen and close apps you are not using.' });
    expect(r.rule_results.find((x) => x.ruleName === 'answers_the_ask')?.judge).toMatchObject({ model: 'claude-sonnet-5', score: 0.9 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('temperature');
  });

  it("verify_citations's judge on a Claude model since 4.7 is sent none, and the citation is judged", async () => {
    __setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);
    const bodies = provider('{"supported":true,"confidence":0.9,"rationale":"It says five."}');
    const result = await verifyCitations({ output: 'The retry limit is five attempts https://a.com/retry.', provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'k', allowFetch: true });
    expect(result.totalJudged).toBe(1);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('temperature');
  });
});

describe('evaluate_with_llm_judge: a temperature set for a model that takes none', () => {
  let storage: SqliteAdapter;
  let client: Client;
  const saved = { anthropic: process.env.IRIS_ANTHROPIC_API_KEY, openai: process.env.IRIS_OPENAI_API_KEY };

  beforeEach(async () => {
    process.env.IRIS_ANTHROPIC_API_KEY = 'sk-ant-dummy-key-for-tests-0123456789';
    process.env.IRIS_OPENAI_API_KEY = 'sk-dummy-key-for-tests-0123456789';
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const server = createIrisServer(defaultConfig, storage);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.mcpServer.connect(s);
    client = new Client({ name: 'judge-temperature', version: '0.1.0' });
    await client.connect(c);
  });

  afterEach(async () => {
    await client.close();
    await storage.close();
    for (const [k, v] of [['IRIS_ANTHROPIC_API_KEY', saved.anthropic], ['IRIS_OPENAI_API_KEY', saved.openai]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  type Out = { score: number; model: string; warnings?: Array<{ code: string; message: string; field?: string }> };
  async function judge(args: Record<string, unknown>): Promise<{ out: Out; bodies: Array<Record<string, unknown>> }> {
    const bodies = provider(VERDICT);
    const r = (await client.callTool({ name: 'evaluate_with_llm_judge', arguments: { output: 'an answer', template: 'accuracy', ...args } })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    const text = r.content.find((c) => c.type === 'text')!.text!;
    expect(r.isError, text).toBeFalsy();
    return { out: JSON.parse(text) as Out, bodies };
  }

  it.each([
    ['claude-opus-5-5', 'anthropic'],
    ['claude-sonnet-5', 'anthropic'],
    ['gpt-5', 'openai'],
  ])('%s: the call is made at its own default, and the response says the temperature was not sent', async (model) => {
    const { out, bodies } = await judge({ model, temperature: 0.3 });
    expect(out.score).toBe(0.8);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('temperature');
    expect(out.warnings).toEqual([{ code: 'IRIS_ARGUMENT_NOT_SENT', field: 'temperature', message: `${model} takes no temperature but its default, so the one set was not sent: the model judged at its own default.` }]);
  });

  it.each(['claude-haiku-4-5', 'gpt-4o'])('%s, which takes one: the temperature set is sent, and nothing is said', async (model) => {
    const { out, bodies } = await judge({ model, temperature: 0.3 });
    expect(bodies[0].temperature).toBe(0.3);
    expect(out.warnings).toBeUndefined();
  });

  it('with no temperature set, a model that takes none is sent none and nothing is said; one that takes one is sent 0', async () => {
    const none = await judge({ model: 'claude-opus-5-5' });
    expect(none.bodies[0]).not.toHaveProperty('temperature');
    expect(none.out.warnings).toBeUndefined();
    const zero = await judge({ model: 'claude-haiku-4-5' });
    expect(zero.bodies[0].temperature).toBe(0);
    expect(zero.out.warnings).toBeUndefined();
  });
});

describe('what the documents say', () => {
  it('the guide to the judge names the Claude models sent a temperature, and they are the ones listed', () => {
    const doc = read('docs/llm-as-judge.md');
    const sentence = /^A Claude model before 4\.7 \(([^)]+)\) is sent the call's `temperature`, 0 unless the call sets one\. Claude 4\.7 and later models take no `temperature` but the default, and Anthropic answers any other value with a 400, so they are sent none and judge at their own default\. A call that sets `temperature` for a model that takes none, of either provider, is still made, and its response carries the warning `IRIS_ARGUMENT_NOT_SENT`\.$/m.exec(doc);
    expect(sentence, 'the sentence in docs/llm-as-judge.md').not.toBeNull();
    const named = sentence![1].split(/, | and /).map((m) => m.replace(/`/g, ''));
    expect(named.sort()).toEqual([...ANTHROPIC_TEMPERATURE_MODELS].filter((m) => !/-\d{8}$/.test(m)).sort());
  });

  it('the warning is in the catalogue, and the tool, the guide, the reference and the changelog name it where they speak of temperature', () => {
    expect(WARNING_CODE_CATALOGUE).toContain('IRIS_ARGUMENT_NOT_SENT');
    const collapse = (s: string): string => s.replace(/\s+/g, ' ');
    expect(read('src/tools/evaluate-with-llm-judge.ts')).toContain("sent only to a model that takes one: Claude 4.7 and later and OpenAI\\'s reasoning models are sent none and judge at their own default, with IRIS_ARGUMENT_NOT_SENT when one was set");
    expect(read('src/tools/evaluate-with-llm-judge.ts')).toContain('IRIS_ARGUMENT_NOT_SENT: temperature was set for a model that takes none, so none was sent');
    expect(collapse(read('src/tools/guide.ts'))).toContain("temperature (default 0) is sent only to a model that takes one: Claude 4.7 and later and OpenAI\\'s reasoning models judge at their own default, with an IRIS_ARGUMENT_NOT_SENT warning when one was set.");
    expect(read('docs/api-reference.md')).toContain("| `temperature` | `number` | No | 0 to 2; default 0. Sent only to a model that takes one: Claude 4.7 and later and OpenAI's reasoning models are sent none and judge at their own default, and a value set for one of them is answered with an `IRIS_ARGUMENT_NOT_SENT` warning |");
    expect(read('CHANGELOG.md')).toContain('- **A Claude model that takes no temperature is sent none (#1078).**');
  });
});
