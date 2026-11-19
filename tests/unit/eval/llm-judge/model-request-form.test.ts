/*
 * Each model is asked in the form it takes (#1078, #1079).
 *
 * Anthropic answers a `temperature` other than the default with a 400 on
 * Claude 4.7 and later models, under the API version Iris sends as well (its
 * model deprecations page), and OpenAI's reasoning models take none: the
 * judge sent every Claude model the call's temperature, 0 unless set, so a
 * call on any Claude model since 4.7 failed. And every Claude 5 model thinks
 * when the request sets no `thinking` (Anthropic's thinking page), at its
 * default effort, inside the same `max_tokens` as its answer: such a model is
 * asked for a low effort. No provider is called here: each request is read
 * as the provider would read it, and each reply is a stand-in in the
 * provider's own shape.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ANTHROPIC_MODELS, callLLMJudge, takesTemperature, type LLMJudgeRequest, type LLMProvider } from '../../../../src/eval/llm-judge/client.js';
import { verdictAnswer } from '../../../../src/eval/llm-judge/answer.js';
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

const request = (provider: LLMProvider, model: string, temperature: number, over: Partial<LLMJudgeRequest> = {}): LLMJudgeRequest => ({
  provider,
  model,
  systemPrompt: 'system',
  userPrompt: 'user',
  maxOutputTokens: 512,
  temperature,
  apiKey: 'k',
  ...over,
});

/** The generation in a Claude model's id: claude-opus-4-8 is 4.8, claude-sonnet-5 is 5, and a dated id is its model's. */
function generation(model: string): number {
  const m = /^claude-[a-z]+-(\d+)(?:-(\d))?(?:-\d{8})?$/.exec(model);
  if (m === null) throw new Error(`not a Claude model id this test can read: ${model}`);
  return Number(m[1]) + Number(m[2] ?? 0) / 10;
}

const effortOf = (body: Record<string, unknown>): unknown => (body.output_config as { effort?: unknown } | undefined)?.effort;

describe('the request each Claude model is sent', () => {
  it.each(pricedModels('anthropic'))('the Claude model %s, priced: a temperature only before 4.7, a low effort only from Claude 5', async (model) => {
    const bodies = provider(VERDICT);
    await callLLMJudge(request('anthropic', model, 0.3));
    expect(bodies).toHaveLength(1);
    if (generation(model) < 4.7) expect(bodies[0].temperature).toBe(0.3);
    else expect(bodies[0]).not.toHaveProperty('temperature');
    if (generation(model) >= 5) expect(bodies[0].output_config).toEqual({ effort: 'low' });
    else expect(bodies[0]).not.toHaveProperty('output_config');
  });

  it('every Claude model Iris prices is listed with how it is asked, and nothing else is', () => {
    expect(Object.keys(ANTHROPIC_MODELS).sort()).toEqual([...pricedModels('anthropic')].sort());
  });

  it.each(Object.entries(ANTHROPIC_MODELS))('%s is listed in the form its generation gives', (model, form) => {
    // Anthropic: a non-default temperature is refused from 4.7; with no thinking field, a Claude 5 model thinks.
    expect(form).toEqual({ temperature: generation(model) < 4.7, thinks: generation(model) >= 5 });
  });

  it('a Claude model not listed is asked as the current ones are: no temperature, a low effort', async () => {
    const bodies = provider(VERDICT);
    await callLLMJudge(request('anthropic', 'claude-opus-6', 0));
    expect(bodies[0]).not.toHaveProperty('temperature');
    expect(effortOf(bodies[0])).toBe('low');
    expect(takesTemperature('anthropic', 'claude-opus-6')).toBe(false);
  });

  it('with an answer asked for, its format and the effort go together in output_config; a model that does not think gets the format alone', async () => {
    const answer = verdictAnswer(['factual_claims', 'citations', 'internal_consistency']);
    const bodies = provider(VERDICT);
    await callLLMJudge(request('anthropic', 'claude-opus-5-5', 0, { answer }));
    await callLLMJudge(request('anthropic', 'claude-opus-4-8', 0, { answer }));
    expect(bodies[0].output_config).toEqual({ format: { type: 'json_schema', schema: answer.schema }, effort: 'low' });
    expect(bodies[1].output_config).toEqual({ format: { type: 'json_schema', schema: answer.schema } });
  });

  it.each([
    ...pricedModels('anthropic').map((m) => ['anthropic', m] as const),
    ...pricedModels('openai').map((m) => ['openai', m] as const),
    // Not listed: a Claude model is sent none, and an OpenAI model is asked as gpt-4o is.
    ['anthropic', 'claude-opus-6'] as const,
    ['openai', 'gpt-unlisted'] as const,
  ])('%s %s: what takesTemperature says is what the request carries', async (p, model) => {
    const bodies = provider(VERDICT);
    await callLLMJudge(request(p, model, 0.3));
    expect('temperature' in bodies[0]).toBe(takesTemperature(p, model));
  });

  it('a temperature of exactly 1, the default, is sent only to a model that takes one, as any other value is', async () => {
    for (const [p, model] of [...pricedModels('anthropic').map((m) => ['anthropic', m] as const), ...pricedModels('openai').map((m) => ['openai', m] as const)]) {
      const bodies = provider(VERDICT);
      await callLLMJudge(request(p, model, 1));
      expect('temperature' in bodies[0], `${p} ${model}`).toBe(takesTemperature(p, model));
    }
  });
});

describe('the callers that set a temperature themselves', () => {
  it('the relevance judge on a Claude 5 model is sent no temperature and a low effort, and its judgment stands', async () => {
    const bodies = provider('{"score":0.9,"passed":true,"rationale":"r","dimensions":{"addresses_request":0.9,"on_subject":0.9,"specific_to_request":0.9}}');
    const engine = new EvalEngine();
    engine.setRelevanceJudge(createRelevanceJudge({ model: 'claude-sonnet-5', apiKey: 'sk-ant-test' }));
    const r = await engine.evaluate('relevance', { input: 'How can I make my laptop battery last longer?', output: 'Dim the screen and close apps you are not using.' });
    expect(r.rule_results.find((x) => x.ruleName === 'answers_the_ask')?.judge).toMatchObject({ model: 'claude-sonnet-5', score: 0.9 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('temperature');
    expect(effortOf(bodies[0])).toBe('low');
  });

  it("verify_citations's judge on a Claude 5 model is sent no temperature and a low effort, and the citation is judged", async () => {
    __setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);
    const bodies = provider('{"supported":true,"confidence":0.9,"rationale":"It says five."}');
    const result = await verifyCitations({ output: 'The retry limit is five attempts https://a.com/retry.', provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'k', allowFetch: true });
    expect(result.totalJudged).toBe(1);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('temperature');
    expect(effortOf(bodies[0])).toBe('low');
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
    client = new Client({ name: 'model-request-form', version: '0.1.0' });
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

  it.each(['claude-opus-5-5', 'claude-sonnet-5', 'gpt-5'])('%s: the call is made at its own default, and the response says the temperature was not sent', async (model) => {
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

  it('a temperature of exactly 1, the default, set for a model that takes none: none is sent, and the response says so', async () => {
    const none = await judge({ model: 'claude-opus-5-5', temperature: 1 });
    expect(none.bodies[0]).not.toHaveProperty('temperature');
    expect(none.out.warnings?.map((w) => w.code)).toEqual(['IRIS_ARGUMENT_NOT_SENT']);
    const takes = await judge({ model: 'claude-haiku-4-5', temperature: 1 });
    expect(takes.bodies[0].temperature).toBe(1);
    expect(takes.out.warnings).toBeUndefined();
  });

  it('beside a cost over the cap and a judge of the agent\'s own family, the warning joins the other two and takes neither\'s place', async () => {
    const { out } = await judge({ model: 'claude-opus-5-5', temperature: 0.3, agent_model: 'claude-opus-5', max_cost_usd: 100 });
    expect(out.warnings?.map((w) => [w.code, w.field])).toEqual([
      ['IRIS_ARGUMENT_NARROWED', 'max_cost_usd'],
      ['IRIS_JUDGE_SAME_FAMILY', undefined],
      ['IRIS_ARGUMENT_NOT_SENT', 'temperature'],
    ]);
  });

  it('with no temperature set, a model that takes none is sent none and nothing is said; one that takes one is sent 0', async () => {
    const none = await judge({ model: 'claude-opus-5-5' });
    expect(none.bodies[0]).not.toHaveProperty('temperature');
    expect(effortOf(none.bodies[0])).toBe('low');
    expect(none.out.warnings).toBeUndefined();
    const zero = await judge({ model: 'claude-haiku-4-5' });
    expect(zero.bodies[0].temperature).toBe(0);
    expect(effortOf(zero.bodies[0])).toBeUndefined();
    expect(zero.out.warnings).toBeUndefined();
  });
});

describe('what the documents say', () => {
  const listed = (pick: (form: { temperature: boolean; thinks: boolean }) => boolean): string[] =>
    Object.entries(ANTHROPIC_MODELS).filter(([id, form]) => pick(form) && !/-\d{8}$/.test(id)).map(([id]) => id).sort();
  const named = (list: string): string[] => list.split(/, | and /).map((m) => m.replace(/`/g, '')).sort();

  it('the guide to the judge names the Claude models sent a temperature, and they are the ones listed', () => {
    const doc = read('docs/llm-as-judge.md');
    const sentence = /^A Claude model before 4\.7 \(([^)]+)\) is sent the call's `temperature`, 0 unless the call sets one\. Claude 4\.7 and later models take no `temperature` but the default, and Anthropic answers any other value with a 400, so they are sent none and judge at their own default\. A call that sets `temperature` for a model that takes none, of either provider, is still made, and its response carries the warning `IRIS_ARGUMENT_NOT_SENT`\.$/m.exec(doc);
    expect(sentence, 'the temperature sentence in docs/llm-as-judge.md').not.toBeNull();
    expect(named(sentence![1])).toEqual(listed((f) => f.temperature));
  });

  it('the guide to the judge names the Claude models asked for a low effort, and they are the ones that think unasked', () => {
    const doc = read('docs/llm-as-judge.md');
    const sentence = /^Every Claude 5 model Iris prices \(([^)]+)\) thinks when the request sets no `thinking`, and its thinking counts against `max_tokens`, the same cap as its answer\. So it is asked for `output_config\.effort: "low"`, at which Claude minimizes its thinking and skips it for a simple task\. A model before Claude 5 thinks only when asked, and is sent no effort\.$/m.exec(doc);
    expect(sentence, 'the effort sentence in docs/llm-as-judge.md').not.toBeNull();
    expect(named(sentence![1])).toEqual(listed((f) => f.thinks));
  });

  it('the warning is in the catalogue, and the tool, the guide, the reference and the changelog name it where they speak of temperature', () => {
    expect(WARNING_CODE_CATALOGUE).toContain('IRIS_ARGUMENT_NOT_SENT');
    const collapse = (s: string): string => s.replace(/\s+/g, ' ');
    expect(read('src/tools/evaluate-with-llm-judge.ts')).toContain("'Sampling temperature, default 0, sent only to a model that takes one: Claude 4.7 and later and OpenAI\\'s reasoning models are sent none and judge at their own default, with IRIS_ARGUMENT_NOT_SENT when one was set'");
    expect(read('src/tools/evaluate-with-llm-judge.ts')).toContain('IRIS_ARGUMENT_NOT_SENT: temperature was set for a model that takes none, so none was sent');
    expect(collapse(read('src/tools/guide.ts'))).toContain("temperature (default 0) is sent only to a model that takes one: Claude 4.7 and later and OpenAI\\'s reasoning models judge at their own default, with an IRIS_ARGUMENT_NOT_SENT warning when one was set.");
    expect(read('docs/api-reference.md')).toContain("| `temperature` | `number` | No | 0 to 2; default 0. Sent only to a model that takes one: Claude 4.7 and later and OpenAI's reasoning models are sent none and judge at their own default, and a value set for one of them is answered with an `IRIS_ARGUMENT_NOT_SENT` warning |");
    expect(read('CHANGELOG.md')).toContain('- **A Claude model that takes no temperature is sent none (#1078).**');
    expect(read('CHANGELOG.md')).toContain('is made at the model\'s own default, and its response carries the new warning `IRIS_ARGUMENT_NOT_SENT`.');
    expect(read('CHANGELOG.md')).toContain('- **A Claude model that thinks unasked is asked for a low effort (#1079).**');
  });

  it('the two changelog entries say, word for word, which models failed and how, the caps, the efforts, and what the steering page says', () => {
    const changelog = read('CHANGELOG.md');
    // #1078: the line at 4.7, the default, and the six priced models that failed, by the kind they failed with.
    expect(changelog).toContain('Anthropic answers a `temperature` other than the default (1) with a 400 on Claude 4.7 and later models');
    expect(changelog).toContain('So a judge call on `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5`, `claude-opus-5`, `claude-opus-4-8` or `claude-opus-4-7` failed with `bad_request`');
    expect(changelog).toContain('A temperature is now sent only to a model that takes one: a Claude model before 4.7, or an OpenAI model that does not reason.');
    // #1079: the default efforts, the caps, the page's sentence whole, the four priced models, the kind, and the line at Claude 5.
    expect(changelog).toContain('Every Claude 5 model thinks when the request sets no `thinking`, at its default effort (`high` on most, `medium` on Claude Opus 5.5 and Claude Haiku 5.5)');
    expect(changelog).toContain('512 for a judgment (256 for its second request) and 256 for each citation of `verify_citations`.');
    expect(changelog).toContain("Anthropic's page on steering thinking says a `max_tokens` sized for a response with no thinking is often too small once Claude starts thinking on hard requests.");
    expect(changelog).toContain('So on `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5` and `claude-opus-5`, a judgment could reach its cap while thinking, before any answer, and fail as a reply cut at its cap (`malformed_response`).');
    expect(changelog).toContain('Each is now asked for `output_config.effort: "low"`, at which Claude minimizes its thinking and skips it for a simple task, beside its answer\'s format; a model before Claude 5, which thinks only when asked, is sent no effort.');
  });
});
