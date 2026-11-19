/*
 * A judge's answer is asked for as structured output, so the reply is the
 * object alone.
 *
 * Each provider is asked in its own form (answer.ts, client.ts): Anthropic by
 * `output_config.format`, OpenAI by a strict `json_schema` response format,
 * for every model Iris prices that offers it. No provider is called here: the
 * request a call sends is read as the provider would read it, and the reply
 * is a stand-in in the provider's own shape.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CITATION_ANSWER, verdictAnswer } from '../../../../src/eval/llm-judge/answer.js';
import { callLLMJudge, estimateInputTokens, OPENAI_MODELS, STRUCTURED_ANSWER_ALLOWANCE_TOKENS, type LLMJudgeRequest } from '../../../../src/eval/llm-judge/client.js';
import { evaluateWithLLMJudge } from '../../../../src/eval/llm-judge/evaluator.js';
import { answerObject } from '../../../../src/eval/llm-judge/reply.js';
import { estimateCostUsd, pricedModels } from '../../../../src/eval/llm-judge/pricing.js';
import { ALL_TEMPLATES } from '../../../../src/eval/llm-judge/templates/index.js';
import { buildCitationJudgePrompts, verifyCitations } from '../../../../src/eval/citation-verify/verifier.js';
import { extractCitations } from '../../../../src/eval/citation-verify/extract.js';
import { __clearCitationCacheForTests, __setDnsLookupForTests } from '../../../../src/eval/citation-verify/resolve.js';

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  __clearCitationCacheForTests();
  __setDnsLookupForTests(null);
});

const ANSWER = '{"score":0.8,"passed":true,"rationale":"r","dimensions":{"factual_claims":0.8,"citations":1,"internal_consistency":0.9}}';

/** Every request a call sends, by its body, and a reply in the provider's own shape. */
function provider(reply: (body: Record<string, unknown>) => Record<string, unknown>): { bodies: Array<Record<string, unknown>>; headers: Array<Record<string, string>> } {
  const bodies: Array<Record<string, unknown>> = [];
  const headers: Array<Record<string, string>> = [];
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith('https://api.anthropic.com/') && !url.startsWith('https://api.openai.com/')) {
      return new Response('The retry limit is five attempts.', { headers: { 'content-type': 'text/plain' } });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    headers.push(init?.headers as Record<string, string>);
    return new Response(JSON.stringify(reply(body)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { bodies, headers };
}
const anthropicReply = (text: string, stop = 'end_turn') => () => ({ id: 'm', content: [{ type: 'text', text }], stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } });
const openAIReply = (message: Record<string, unknown>, finish = 'stop') => () => ({ id: 'c', choices: [{ message, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

const request = (over: Partial<LLMJudgeRequest>): LLMJudgeRequest => ({
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  systemPrompt: 'system',
  userPrompt: 'user',
  maxOutputTokens: 512,
  temperature: 0,
  apiKey: 'k',
  ...over,
});
const answer = verdictAnswer(['factual_claims', 'citations', 'internal_consistency']);

describe('the answer each provider is asked for', () => {
  it('Anthropic: the schema in output_config.format, with the version and the temperature as before, and no tool', async () => {
    const p = provider(anthropicReply(ANSWER));
    const res = await callLLMJudge(request({ answer }));
    expect(p.bodies[0].output_config).toEqual({ format: { type: 'json_schema', schema: answer.schema } });
    expect(p.bodies[0]).toMatchObject({ model: 'claude-haiku-4-5', max_tokens: 512, temperature: 0, system: 'system' });
    expect(p.bodies[0]).not.toHaveProperty('tools');
    expect(p.bodies[0]).not.toHaveProperty('tool_choice');
    expect(p.headers[0]['anthropic-version']).toBe('2023-06-01');
    expect(res).toMatchObject({ content: ANSWER, structured: true });
  });

  it('Anthropic, with no answer asked for: no output_config, and the reply is text', async () => {
    const p = provider(anthropicReply('text'));
    const res = await callLLMJudge(request({}));
    expect(p.bodies[0]).not.toHaveProperty('output_config');
    expect(res.structured).toBe(false);
  });

  it('OpenAI, a model that is not a reasoning model: max_completion_tokens, the temperature, and a strict json_schema response format', async () => {
    const p = provider(openAIReply({ content: ANSWER }));
    const res = await callLLMJudge(request({ provider: 'openai', model: 'gpt-4o-mini', answer }));
    expect(p.bodies[0]).toMatchObject({ model: 'gpt-4o-mini', max_completion_tokens: 512, temperature: 0 });
    expect(p.bodies[0]).not.toHaveProperty('max_tokens');
    expect(p.bodies[0]).not.toHaveProperty('reasoning_effort');
    expect(p.bodies[0].response_format).toEqual({ type: 'json_schema', json_schema: { name: 'verdict', schema: answer.schema, strict: true } });
    expect(res).toMatchObject({ content: ANSWER, structured: true });
  });

  it.each(['gpt-5', 'gpt-5-mini', 'o3-mini', 'o4-mini'])('OpenAI, the reasoning model %s: no temperature, a low reasoning effort, max_completion_tokens, and the response format', async (model) => {
    const p = provider(openAIReply({ content: ANSWER }));
    await callLLMJudge(request({ provider: 'openai', model, answer }));
    expect(p.bodies[0]).not.toHaveProperty('temperature');
    expect(p.bodies[0]).not.toHaveProperty('max_tokens');
    expect(p.bodies[0]).toMatchObject({ max_completion_tokens: 512, reasoning_effort: 'low' });
    expect(p.bodies[0]).toHaveProperty('response_format');
  });

  it('OpenAI o1-mini, which offers no structured output: asked in text, with no temperature and no reasoning effort', async () => {
    const p = provider(openAIReply({ content: `Here: ${ANSWER}` }));
    const res = await callLLMJudge(request({ provider: 'openai', model: 'o1-mini', answer }));
    expect(p.bodies[0]).not.toHaveProperty('response_format');
    expect(p.bodies[0]).not.toHaveProperty('temperature');
    expect(p.bodies[0]).not.toHaveProperty('reasoning_effort');
    expect(p.bodies[0]).toMatchObject({ max_completion_tokens: 512 });
    expect(res.structured).toBe(false);
  });

  it('OpenAI, a model Iris does not list: asked as gpt-4o is', async () => {
    const p = provider(openAIReply({ content: ANSWER }));
    await callLLMJudge(request({ provider: 'openai', model: 'some-later-model', answer }));
    expect(p.bodies[0]).toMatchObject({ temperature: 0, max_completion_tokens: 512 });
    expect(p.bodies[0]).toHaveProperty('response_format');
  });

  it('every OpenAI model Iris prices is listed with how it is asked', () => {
    expect(pricedModels('openai').filter((m) => !(m in OPENAI_MODELS))).toEqual([]);
    expect(Object.keys(OPENAI_MODELS).filter((m) => !pricedModels('openai').includes(m))).toEqual([]);
  });

  it.each(pricedModels('anthropic'))('the Claude model %s, priced, is asked for its answer as structured output', async (model) => {
    const p = provider(anthropicReply(ANSWER));
    const res = await callLLMJudge(request({ model, answer }));
    expect(p.bodies[0].output_config).toEqual({ format: { type: 'json_schema', schema: answer.schema } });
    expect(res).toMatchObject({ content: ANSWER, structured: true });
  });

  /** How each OpenAI model Iris prices is asked, as its page at OpenAI gives it: a reasoning model takes no temperature, and structured output where the page lists it. */
  const OPENAI_FORMS: Record<string, { reasoning: boolean; effort?: 'low'; structured: boolean }> = {
    'gpt-5': { reasoning: true, effort: 'low', structured: true },
    'gpt-5-mini': { reasoning: true, effort: 'low', structured: true },
    'o4-mini': { reasoning: true, effort: 'low', structured: true },
    'o3-mini': { reasoning: true, effort: 'low', structured: true },
    'o1-mini': { reasoning: true, structured: false },
    'gpt-4.1-mini': { reasoning: false, structured: true },
    'gpt-4o': { reasoning: false, structured: true },
    'gpt-4o-mini': { reasoning: false, structured: true },
  };

  it('the forms below name every OpenAI model Iris prices', () => {
    expect(Object.keys(OPENAI_FORMS).sort()).toEqual([...pricedModels('openai')].sort());
  });

  it.each(Object.entries(OPENAI_FORMS))('the OpenAI model %s is asked in the form its page gives', async (model, form) => {
    const p = provider(openAIReply({ content: ANSWER }));
    const res = await callLLMJudge(request({ provider: 'openai', model, answer }));
    const body = p.bodies[0];
    expect(body.max_completion_tokens).toBe(512);
    expect(body).not.toHaveProperty('max_tokens');
    expect('temperature' in body).toBe(!form.reasoning);
    expect(body.reasoning_effort).toBe(form.effort);
    expect(body.response_format).toEqual(form.structured ? { type: 'json_schema', json_schema: { name: 'verdict', schema: answer.schema, strict: true } } : undefined);
    expect(res).toMatchObject({ content: ANSWER, structured: form.structured });
  });
});

describe('an OpenAI reply with no answer says why', () => {
  it('a model that declines: its refusal, in the message', async () => {
    provider(openAIReply({ content: null, refusal: 'I cannot help with that.' }));
    await expect(callLLMJudge(request({ provider: 'openai', model: 'gpt-4o-mini', answer }))).rejects.toMatchObject({
      kind: 'malformed_response',
      message: "OpenAI's model declined to answer: I cannot help with that.",
    });
  });

  it('a reply that reached its cap before any answer: the cap, and for a reasoning model that its reasoning counts against it', async () => {
    provider(openAIReply({ content: '' }, 'length'));
    await expect(callLLMJudge(request({ provider: 'openai', model: 'gpt-5', answer }))).rejects.toMatchObject({
      kind: 'malformed_response',
      message: "OpenAI response had no message content: it ended at its output limit (max_completion_tokens 512, which this model's reasoning counts against)",
    });
    provider(openAIReply({ content: null }, 'length'));
    await expect(callLLMJudge(request({ provider: 'openai', model: 'gpt-4o-mini', answer }))).rejects.toMatchObject({
      message: 'OpenAI response had no message content: it ended at its output limit (max_completion_tokens 512)',
    });
    provider(openAIReply({ content: null }));
    await expect(callLLMJudge(request({ provider: 'openai', model: 'gpt-4o-mini', answer }))).rejects.toMatchObject({ message: 'OpenAI response had no message content' });
  });

  it('an empty refusal says nothing, and a long one is shown to its first 200 characters', async () => {
    provider(openAIReply({ content: null, refusal: '' }));
    await expect(callLLMJudge(request({ provider: 'openai', model: 'gpt-4o-mini', answer }))).rejects.toMatchObject({ kind: 'malformed_response', message: 'OpenAI response had no message content' });
    provider(openAIReply({ content: null, refusal: `${'x'.repeat(200)}${'y'.repeat(100)}` }));
    await expect(callLLMJudge(request({ provider: 'openai', model: 'gpt-4o-mini', answer }))).rejects.toMatchObject({ kind: 'malformed_response', message: `OpenAI's model declined to answer: ${'x'.repeat(200)}` });
  });
});

describe('what the documents say of each road', () => {
  const read = (path: string): string => readFileSync(resolve(__dirname, '..', '..', '..', '..', path), 'utf8');

  it('o1-mini, asked in text, is sent no reasoning effort and its answer is not held to the schema; each message a caller can meet has its row', () => {
    const doc = read('docs/llm-as-judge.md');
    const log = read('CHANGELOG.md');
    expect(doc).toContain('and a low reasoning effort where the model takes one (`o1-mini` takes none)');
    expect(log).toContain('and `reasoning_effort: "low"` where the model takes one (`o1-mini` takes none)');
    expect(log).toContain("Asked for as structured output, the answer names each template's three dimensions, and no others; from `o1-mini`, asked in text, the dimensions are read as before.");
    for (const row of ['| `Judge reply is not the JSON object it was asked for`', "| `OpenAI's model declined to answer: ...`", '| `OpenAI response had no message content: it ended at its output limit (max_completion_tokens ...)`']) {
      expect(doc, row).toContain(row);
    }
    expect(doc).toContain('which the second request, whose cap is no larger (256 at most), seldom does. An OpenAI model that declines, or whose reply reaches its cap before any answer, is not asked again');
  });
});

describe('a reply asked for as structured output is read whole', () => {
  it('JSON white space around the object is read; any other character beside it is not; asked in text, the object is read as before', () => {
    expect(answerObject(` \n${ANSWER}\n\t `, true)).toMatchObject({ score: 0.8 });
    for (const beside of ['﻿', ' ', ' ', '\u0000']) {
      expect(answerObject(`${beside}${ANSWER}`, true), JSON.stringify(beside)).toBeNull();
      expect(answerObject(`${ANSWER}${beside}`, true), JSON.stringify(beside)).toBeNull();
    }
    expect(answerObject(`﻿Here it is: ${ANSWER}`, false)).toMatchObject({ score: 0.8 });
  });
});

describe('the schema both providers take', () => {
  const schemas = [...ALL_TEMPLATES.map((t) => [t.name, verdictAnswer(t.dimensions).schema] as const), ['citation', CITATION_ANSWER.schema] as const];

  /** Every object in a schema, with its path. */
  function objects(schema: Record<string, unknown>, path = '$'): Array<[string, Record<string, unknown>]> {
    const out: Array<[string, Record<string, unknown>]> = [[path, schema]];
    for (const [key, value] of Object.entries((schema.properties ?? {}) as Record<string, Record<string, unknown>>)) {
      if (value.type === 'object') out.push(...objects(value, `${path}.${key}`));
    }
    return out;
  }

  it.each(schemas)('%s: every object names its keys, requires each, and allows no other', (_name, schema) => {
    for (const [path, object] of objects(schema)) {
      expect(object.type, path).toBe('object');
      expect(object.additionalProperties, path).toBe(false);
      expect(object.required, path).toEqual(Object.keys(object.properties as object));
      expect(Object.keys(object.properties as object).length, path).toBeGreaterThan(0);
    }
  });

  it.each(schemas)('%s: no bound on a number, and no keyword either provider refuses', (_name, schema) => {
    const text = JSON.stringify(schema);
    for (const keyword of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'oneOf', 'not', 'allOf', 'patternProperties', '$ref']) {
      expect(text, keyword).not.toContain(`"${keyword}"`);
    }
    // Only the types the answer uses.
    expect([...text.matchAll(/"type":"([a-z]+)"/g)].map((m) => m[1]).filter((t) => !['object', 'number', 'boolean', 'string'].includes(t))).toEqual([]);
  });

  it('the verdict and the citation answer, field by field: each field of its type, and nothing else in either schema', () => {
    const closed = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
    expect(verdictAnswer(['a', 'b', 'c'])).toEqual({
      name: 'verdict',
      schema: closed({
        score: { type: 'number' },
        passed: { type: 'boolean' },
        rationale: { type: 'string' },
        dimensions: closed({ a: { type: 'number' }, b: { type: 'number' }, c: { type: 'number' } }),
      }),
    });
    expect(CITATION_ANSWER).toEqual({
      name: 'citation_verdict',
      schema: closed({ supported: { type: 'boolean' }, confidence: { type: 'number' }, rationale: { type: 'string' } }),
    });
  });

  it('the verdict asks for the score first, then the pass, the rationale and the dimensions, as the prompt does', () => {
    expect(Object.keys((verdictAnswer(['a', 'b', 'c']).schema.properties as object))).toEqual(['score', 'passed', 'rationale', 'dimensions']);
    expect(Object.keys((CITATION_ANSWER.schema.properties as object))).toEqual(['supported', 'confidence', 'rationale']);
  });

  it.each(ALL_TEMPLATES.map((t) => [t.name, t] as const))('%s: the dimensions it names are the ones its prompt says must be included, in order', (_name, template) => {
    const line = template.buildSystem().split('\n').find((l) => l.startsWith('Dimensions MUST include: '));
    expect(line).toBeDefined();
    const named = [...line!.slice('Dimensions MUST include: '.length).matchAll(/([a-z_]+) \(/g)].map((m) => m[1]);
    expect(named).toEqual([...template.dimensions]);
    expect(template.dimensions).toHaveLength(3);
  });
});

describe('the estimate counts what a request carries', () => {
  it('with an answer: its name, its schema, and the allowance for the provider\'s instructions; without one, as before', () => {
    expect(estimateInputTokens('a'.repeat(400), 'b'.repeat(400))).toBe(200);
    const carried = answer.name.length + JSON.stringify(answer.schema).length;
    expect(estimateInputTokens('a'.repeat(400), 'b'.repeat(400), answer)).toBe(Math.ceil((800 + carried) / 4) + STRUCTURED_ANSWER_ALLOWANCE_TOKENS);
    expect(STRUCTURED_ANSWER_ALLOWANCE_TOKENS).toBe(1_000);
  });

  it("a cap on the request's input counts them too", async () => {
    let called = false;
    global.fetch = vi.fn(async () => {
      called = true;
      return new Response();
    }) as typeof fetch;
    // 200 tokens of prompt fit a cap of 300; with the answer they do not.
    await expect(callLLMJudge(request({ systemPrompt: 'a'.repeat(400), userPrompt: 'b'.repeat(400), maxInputTokensEstimate: 300, answer }))).rejects.toMatchObject({ kind: 'bad_request' });
    expect(called).toBe(false);
  });
});

describe('the callers ask for their answers', () => {
  it('evaluate_with_llm_judge asks for its template\'s answer in both requests', async () => {
    let n = 0;
    const p = provider(() => {
      n += 1;
      return anthropicReply(n === 1 ? '{"score":null,"passed":true,"rationale":"r","dimensions":{"addresses_question":1,"specificity":1,"actionability":1}}' : '{"score":0.9,"passed":true,"rationale":"r","dimensions":{"addresses_question":1,"specificity":1,"actionability":1}}')();
    });
    const res = await evaluateWithLLMJudge({ output: 'o', template: 'helpfulness', provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k' });
    expect(res.score).toBe(0.9);
    const expected = { format: { type: 'json_schema', schema: verdictAnswer(['addresses_question', 'specificity', 'actionability']).schema } };
    expect(p.bodies.map((b) => b.output_config)).toEqual([expected, expected]);
  });

  it("verify_citations prices a citation's answer, its schema and the allowance, in the citation's worst case", async () => {
    __setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);
    const output = 'The retry limit is five attempts https://a.com/retry.';
    const [citation] = extractCitations(output);
    const prompts = buildCitationJudgePrompts(citation.contextWindow, 'The retry limit is five attempts.');
    const without = estimateCostUsd('claude-haiku-4-5', estimateInputTokens(prompts.system, prompts.user), 256)!;
    const withAnswer = estimateCostUsd('claude-haiku-4-5', estimateInputTokens(prompts.system, prompts.user, CITATION_ANSWER), 256)!;
    // A thousand tokens at $1 per million, and the schema.
    expect(withAnswer - without).toBeGreaterThan(0.001);
    const p = provider(anthropicReply('{"supported":true,"confidence":0.9,"rationale":"It says five."}'));
    const res = await verifyCitations({ output, provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k', allowFetch: true, maxCostUsdTotal: (without + withAnswer) / 2 });
    expect(res.citations[0].judgeError?.kind).toBe('cost_cap_reached');
    expect(p.bodies).toHaveLength(0);
  });

  it("verify_citations asks for the citation judge's answer", async () => {
    __setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);
    const p = provider(openAIReply({ content: '{"supported":true,"confidence":0.9,"rationale":"It says five."}' }));
    const result = await verifyCitations({ output: 'The retry limit is five attempts https://a.com/retry.', provider: 'openai', model: 'gpt-4o-mini', apiKey: 'k', allowFetch: true });
    expect(result.totalJudged).toBe(1);
    expect(p.bodies[0].response_format).toEqual({ type: 'json_schema', json_schema: { name: 'citation_verdict', schema: CITATION_ANSWER.schema, strict: true } });
  });
});
