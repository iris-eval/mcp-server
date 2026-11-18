/*
 * A judge's reply is read as a score only when it gives one.
 *
 * The judge is asked for a single JSON object with a number from 0 to 1
 * under `score`. The score was converted with Number(), which makes a
 * number of things that are not one: `null`, `false`, `""` and `[]` convert
 * to 0, and `true` converts to 1. Each such reply is malformed now: it is
 * asked for again once, and if the second reply is no better the call fails
 * as one that got no answer, which is what happened.
 *
 * The object itself is read as before, from the reply's first brace to its
 * last.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateWithLLMJudge, SECOND_REQUEST, worstCaseJudgeCostUsd } from '../../../../src/eval/llm-judge/evaluator.js';
import { estimateInputTokens } from '../../../../src/eval/llm-judge/client.js';
import { estimateCostUsd } from '../../../../src/eval/llm-judge/pricing.js';
import { getTemplate } from '../../../../src/eval/llm-judge/templates/index.js';
import { replyObject, shownReply, shownValue, unitNumber } from '../../../../src/eval/llm-judge/reply.js';

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

/** A provider that answers each call with the next reply text, and the last one from then on. It keeps the system prompt of each call. */
function judgeReplies(...texts: string[]): { calls: () => number; systems: string[] } {
  let n = 0;
  const systems: string[] = [];
  global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    systems.push(String((JSON.parse(String(init?.body ?? '{}')) as { system?: unknown }).system ?? ''));
    const text = texts[Math.min(n, texts.length - 1)];
    n += 1;
    return new Response(JSON.stringify({ id: `m${n}`, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 30 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls: () => n, systems };
}

const ask = (): ReturnType<typeof evaluateWithLLMJudge> => evaluateWithLLMJudge({ output: 'The sky is blue.', template: 'accuracy', provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k' });
const reply = (score: string): string => `{"score":${score},"rationale":"as asked","dimensions":{}}`;
const GOOD = reply('0.6');

// What a reply can put where the score belongs, as JSON text. Number() makes 0 of the first four, 1 of the fifth and 0.9 of the next two.
// The last seven are numbers outside the range: two that round to an end of it at two decimals, one a single step past 1, and two too large to hold.
const NOT_A_SCORE = ['null', 'false', '""', '[]', 'true', '[0.9]', '"0.9"', '{}', '"high"', '{"value":0.9}', '-0.01', '1.01', '1.004', '-0.004', '1.0000000000000002', '1e400', '-1e400'];

describe('unitNumber: the number a reply gives for a field from 0 to 1', () => {
  it('is the number when the reply gives one in range', () => {
    for (const n of [0, 0.5, 1, 0.999, 1e-9, 5e-324]) expect(unitNumber(n), String(n)).toBe(n);
  });

  it('is null for anything else, where Number() would make a number of it', () => {
    for (const value of [null, undefined, false, true, '', '0.9', ' 1 ', [], [0.9], {}, { valueOf: () => 0.5 }]) expect(unitNumber(value), shownValue(value)).toBeNull();
  });

  it('is null for a number outside the range, by however little, and for one that is not a quantity', () => {
    for (const value of [-0.01, 1.01, 2, 1.004, -0.004, 1.0000000000000002, -1e-300, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expect(unitNumber(value), String(value)).toBeNull();
  });

  it('shownValue says what the reply gave, and cuts a long value short', () => {
    expect(shownValue(null)).toBe('null');
    expect(shownValue(undefined)).toBe('no value');
    expect(shownValue('0.9')).toBe('"0.9"');
    expect(shownValue([0.9])).toBe('[0.9]');
    expect(shownValue('x'.repeat(500)).length).toBeLessThanOrEqual(81);
    // JSON writes a number too large to hold as null, which the reply did not give.
    expect(shownValue(Number.POSITIVE_INFINITY)).toBe('Infinity');
    expect(shownValue(Number.NEGATIVE_INFINITY)).toBe('-Infinity');
  });
});

describe('replyObject: the JSON object a reply holds, from its first brace to its last, as before', () => {
  const OBJECT = '{"score":0.7,"rationale":"ok"}';

  it('is the object, alone or with anything around it: a code fence, a sentence before it or after it, a list', () => {
    const around = [
      OBJECT,
      `  ${OBJECT}\n`,
      `\`\`\`json\n${OBJECT}\n\`\`\``,
      `~~~\n${OBJECT}\n~~~`,
      `Here is the evaluation:\n${OBJECT}`,
      `${OBJECT}\nI hope that helps.`,
      `Here is the evaluation:\n\`\`\`json\n${OBJECT}\n\`\`\`\nDone.`,
      `[${OBJECT}]`,
    ];
    for (const text of around) expect(replyObject(text), JSON.stringify(text)).toEqual({ score: 0.7, rationale: 'ok' });
    expect(replyObject('{}')).toEqual({});
  });

  it('is null when the reply holds no braces, braces in the wrong order, or text between them that is not JSON', () => {
    for (const text of ['never json', '', '   ', '0.7', 'null', '"x"', '}{', '{', '}', '{"score":0.7,}', "{'score':0.7}", '{score:0.7}', `${OBJECT}${OBJECT}`, `${OBJECT}\n${OBJECT}`]) {
      expect(replyObject(text), JSON.stringify(text)).toBeNull();
    }
  });

  it('is null for a reply that is not text', () => {
    for (const value of [undefined, null, 0.7, { score: 0.7 }, [OBJECT]]) expect(replyObject(value), shownValue(value)).toBeNull();
  });

  it('a value too deep to write out is shown by its kind, and a long reply by its start', () => {
    let deep: unknown = 0.9;
    for (let i = 0; i < 10_000; i++) deep = [deep];
    expect(shownValue(deep)).toBe('object');
    expect(shownReply('x'.repeat(500))).toBe('x'.repeat(200));
    expect(shownReply(0.84)).toBe('a reply of type number');
  });
});

describe('a judge reply that gives no score is not read as one', () => {
  it.each(NOT_A_SCORE)('a score of %s is a malformed reply: it is asked for again, and the call fails when the second reply is the same', async (score) => {
    const provider = judgeReplies(reply(score));
    await expect(ask()).rejects.toMatchObject({ kind: 'malformed_response' });
    expect(provider.calls()).toBe(2);
  });

  it('a reply with no score at all is malformed too', async () => {
    const provider = judgeReplies('{"rationale":"as asked","dimensions":{}}');
    await expect(ask()).rejects.toMatchObject({ kind: 'malformed_response' });
    expect(provider.calls()).toBe(2);
  });

  it('the error says what the reply gave in place of a score', async () => {
    judgeReplies(reply('null'));
    await expect(ask()).rejects.toThrow('Judge score is not a number from 0 to 1: null');
    judgeReplies(reply('"0.9"'));
    await expect(ask()).rejects.toThrow('Judge score is not a number from 0 to 1: "0.9"');
    judgeReplies('{"rationale":"as asked"}');
    await expect(ask()).rejects.toThrow('Judge score is not a number from 0 to 1: no value');
    // A number too large to hold is named as what it is, not as the null JSON would write for it.
    judgeReplies(reply('1e400'));
    await expect(ask()).rejects.toThrow('Judge score is not a number from 0 to 1: Infinity');
  });

  it('the two verdicts that such a reply used to give are not given: true does not pass, and null does not fail', async () => {
    // Number(true) is 1, over every template's threshold; Number(null) is 0, under it.
    judgeReplies(reply('true'));
    await expect(ask()).rejects.toMatchObject({ kind: 'malformed_response' });
    judgeReplies(reply('null'));
    await expect(ask()).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it('a second reply that gives a score is the answer, and both calls are paid for', async () => {
    const provider = judgeReplies(reply('null'), GOOD);
    const result = await ask();
    expect(provider.calls()).toBe(2);
    expect(result.score).toBe(0.6);
    expect(result.inputTokens).toBe(200);
    expect(result.outputTokens).toBe(60);
    // 200 input tokens at 1 USD a million and 60 output tokens at 5: the cost of two calls, not of the last.
    expect(result.costUsd).toBe(0.0005);
  });

  it('the second request says what was wrong in words that are true of every malformed reply, and asks for a number', async () => {
    const provider = judgeReplies(reply('"0.9"'), GOOD);
    await ask();
    expect(provider.systems).toHaveLength(2);
    const added = provider.systems[1].slice(provider.systems[0].length);
    expect(provider.systems[1].startsWith(provider.systems[0])).toBe(true);
    // The sentence, whole: it is what the model is told, and every character of it is priced (below). The reply WAS valid JSON, and the request does not say otherwise.
    expect(added).toBe('\n\nIMPORTANT: your previous response could not be read. Respond with ONLY the JSON object: nothing before or after it, no code fences, and "score" as a number, not in quotes.');
    expect(added).toBe(SECOND_REQUEST);
  });

  it('the worst case a call is priced at counts the second request, every character of it', () => {
    const params = { template: 'accuracy' as const, model: 'claude-haiku-4-5', output: 'The sky is blue.' };
    const template = getTemplate('accuracy');
    const system = template.buildSystem();
    const user = template.buildUser({ output: params.output });
    // The first request at the full output cap, and the second, with its sentence, at its own.
    const first = estimateCostUsd(params.model, estimateInputTokens(system, user), 512)!;
    const second = estimateCostUsd(params.model, estimateInputTokens(system + SECOND_REQUEST, user), 256)!;
    expect(worstCaseJudgeCostUsd(params)).toBe(first + second);
    // 173 characters: 48 more than the sentence it replaced, which is twelve tokens in every call's worst case (a quarter of a token a character).
    expect(SECOND_REQUEST).toHaveLength(173);
    const withoutIt = estimateCostUsd(params.model, estimateInputTokens(system, user), 256)!;
    expect(second).toBeGreaterThan(withoutIt);
    expect(estimateInputTokens(system + SECOND_REQUEST, user) - estimateInputTokens(system + 'x'.repeat(125), user)).toBe(12);
  });

  it('a score too deep to write out, and a reply too long to show, are malformed replies like any other', async () => {
    const provider = judgeReplies(reply(`${'['.repeat(10_000)}0.9${']'.repeat(10_000)}`));
    await expect(ask()).rejects.toThrow('Judge score is not a number from 0 to 1: object');
    expect(provider.calls()).toBe(2);
    // A reply that holds no object is shown by its first 200 characters.
    judgeReplies('x'.repeat(500));
    const error = await ask().then(
      () => null,
      (e: Error) => e,
    );
    expect(error?.message).toBe(`Judge reply holds no JSON object: ${'x'.repeat(200)}`);
  });

  it('a score of 0 and a score of 1 are scores: the ends of the range are read as given', async () => {
    judgeReplies(reply('0'));
    expect(await ask()).toMatchObject({ score: 0, passed: false });
    judgeReplies(reply('1'));
    expect(await ask()).toMatchObject({ score: 1, passed: true });
    judgeReplies(reply('1.0'));
    expect(await ask()).toMatchObject({ score: 1, passed: true });
  });

  it('a score is rounded to two decimals, as before', async () => {
    judgeReplies(reply('0.846'));
    expect((await ask()).score).toBe(0.85);
    judgeReplies(reply('0.8449'));
    expect((await ask()).score).toBe(0.84);
  });

  it('a dimension is kept as the reply gave it when that is a number, and left out otherwise', async () => {
    judgeReplies('{"score":0.8,"rationale":"r","dimensions":{"a":0.9,"b":null,"c":true,"d":"0.5","e":[1],"f":1,"g":false,"h":""}}');
    expect((await ask()).dimensions).toEqual({ a: 0.9, f: 1 });
    // Not rounded, and not held to the score's range; a number too large to hold is not a number the reply gave.
    judgeReplies('{"score":0.8,"rationale":"r","dimensions":{"exact":0.123456,"five":5,"below":-1,"huge":1e400}}');
    expect((await ask()).dimensions).toEqual({ exact: 0.123456, five: 5, below: -1 });
    // A list where the dimensions belong names none.
    judgeReplies('{"score":0.8,"rationale":"r","dimensions":[0.9,0.1]}');
    expect((await ask()).dimensions).toEqual({});
  });

  it("the model's own verdict is recorded only when it is a boolean", async () => {
    judgeReplies('{"score":0.95,"passed":"false","rationale":"r","dimensions":{}}');
    const quoted = await ask();
    expect(quoted.passed).toBe(true);
    expect(quoted.selfReportedPass).toBeUndefined();
    expect(quoted.disagreement).toBeUndefined();
    judgeReplies('{"score":0.95,"passed":false,"rationale":"r","dimensions":{}}');
    expect(await ask()).toMatchObject({ passed: true, selfReportedPass: false, disagreement: true });
  });
});

describe("the object is read from the reply's first brace to its last, as before", () => {
  it.each([
    ['a sentence before the object', `Here is the evaluation:\n${GOOD}`],
    ['a sentence after the object', `${GOOD}\nI hope that helps.`],
    ['a code fence around the object', `\`\`\`json\n${GOOD}\n\`\`\``],
    ['a sentence around a fenced object', `Here is the evaluation:\n\`\`\`json\n${GOOD}\n\`\`\`\nDone.`],
  ])('%s: the score is read, on one call', async (_what, text) => {
    const provider = judgeReplies(text);
    expect((await ask()).score).toBe(0.6);
    expect(provider.calls()).toBe(1);
  });

  it('a reply that holds no object is malformed: it is asked for again, and the error shows its start', async () => {
    const provider = judgeReplies('I cannot evaluate this text.');
    await expect(ask()).rejects.toThrow('Judge reply holds no JSON object: I cannot evaluate this text.');
    expect(provider.calls()).toBe(2);
  });
});
