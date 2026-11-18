/*
 * A judge's reply is read as a score only when it gives one.
 *
 * The judge is asked for JSON with a number from 0 to 1 under `score`. The
 * reply's score used to be converted with Number(), which makes a number of
 * things that are not one: `null`, `false`, `""` and `[]` convert to 0, and
 * `true` converts to 1. So a reply that gave no score failed the output, or
 * passed it. Each of those is a malformed reply: it is asked for again once,
 * and if the second reply is no better the call fails as one that got no
 * answer, which is what happened.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateWithLLMJudge } from '../../../../src/eval/llm-judge/evaluator.js';
import { shownValue, unitNumber } from '../../../../src/eval/llm-judge/reply.js';

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

/** A provider that answers each call with the next reply text, and the last one from then on. Returns how many calls it took. */
function judgeReplies(...texts: string[]): { calls: () => number } {
  let n = 0;
  global.fetch = vi.fn(async () => {
    const text = texts[Math.min(n, texts.length - 1)];
    n += 1;
    return new Response(JSON.stringify({ id: `m${n}`, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 30 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls: () => n };
}

const ask = (): ReturnType<typeof evaluateWithLLMJudge> => evaluateWithLLMJudge({ output: 'The sky is blue.', template: 'accuracy', provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k' });
const reply = (score: string): string => `{"score":${score},"rationale":"as asked","dimensions":{}}`;

// What a reply can put where the score belongs, as JSON text. Number() makes 0 of the first four, 1 of the fifth and 0.9 of the next two.
const NOT_A_SCORE = ['null', 'false', '""', '[]', 'true', '[0.9]', '"0.9"', '{}', '"high"', '{"value":0.9}', '1e400', '-0.01', '1.01'];

describe('unitNumber: the number a reply gives for a field from 0 to 1', () => {
  it('is the number when the reply gives one in range', () => {
    for (const n of [0, 0.5, 1, 0.999, 1e-9]) expect(unitNumber(n), String(n)).toBe(n);
  });

  it('is null for anything else, where Number() would make a number of it', () => {
    for (const value of [null, undefined, false, true, '', '0.9', ' 1 ', [], [0.9], {}, { valueOf: () => 0.5 }, Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.01, 2]) {
      expect(unitNumber(value), shownValue(value)).toBeNull();
    }
  });

  it('shownValue says what the reply gave, and cuts a long value short', () => {
    expect(shownValue(null)).toBe('null');
    expect(shownValue(undefined)).toBe('no value');
    expect(shownValue('0.9')).toBe('"0.9"');
    expect(shownValue([0.9])).toBe('[0.9]');
    expect(shownValue('x'.repeat(500)).length).toBeLessThanOrEqual(81);
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
  });

  it('the two verdicts that such a reply used to give are not given: true does not pass, and null does not fail', async () => {
    // Number(true) is 1, over every template's threshold; Number(null) is 0, under it.
    judgeReplies(reply('true'));
    await expect(ask()).rejects.toMatchObject({ kind: 'malformed_response' });
    judgeReplies(reply('null'));
    await expect(ask()).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it('a second reply that gives a score is the answer, and both calls are paid for', async () => {
    const provider = judgeReplies(reply('null'), reply('0.6'));
    const result = await ask();
    expect(provider.calls()).toBe(2);
    expect(result.score).toBe(0.6);
    expect(result.inputTokens).toBe(200);
    expect(result.outputTokens).toBe(60);
  });

  it('a score of 0 and a score of 1 are scores: the ends of the range are read as given', async () => {
    judgeReplies(reply('0'));
    expect(await ask()).toMatchObject({ score: 0, passed: false });
    judgeReplies(reply('1'));
    expect(await ask()).toMatchObject({ score: 1, passed: true });
    judgeReplies(reply('1.0'));
    expect(await ask()).toMatchObject({ score: 1, passed: true });
  });

  it('a dimension is kept when the reply gives a number for it, and left out otherwise', async () => {
    judgeReplies('{"score":0.8,"rationale":"r","dimensions":{"a":0.9,"b":null,"c":true,"d":"0.5","e":[1],"f":1,"g":false,"h":""}}');
    expect((await ask()).dimensions).toEqual({ a: 0.9, f: 1 });
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
