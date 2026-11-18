/*
 * The citation judge's reply is read as a verdict only when it gives one.
 *
 * The judge is asked for a single JSON object, with `"supported": <boolean>`
 * and a confidence from 0 to 1. Two freedoms in how the reply was read each
 * became a verdict:
 *
 *   - the verdict was read as `supported === true`, so a reply that left it
 *     out, or gave `null`, or gave `"true"` in quotes, read as "not
 *     supported": a verdict against the citation, from a reply that made
 *     none, and `passed: false` for the whole output;
 *   - the confidence was converted with Number(), which reads `null` as 0
 *     and `true` as 1.
 *
 * Each is a malformed reply: the citation is reported as not judged, and
 * takes no part in the verdict. The judge is asked once for each citation.
 * Where the judge is asked for its answer as structured output (every model
 * Iris prices but one), the reply is the object alone and is read whole;
 * from a model that offers none, the object is read as before, from the
 * reply's first brace to its last.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyCitations } from '../../../../src/eval/citation-verify/verifier.js';
import { __clearCitationCacheForTests, __setDnsLookupForTests } from '../../../../src/eval/citation-verify/resolve.js';

const originalFetch = global.fetch;
beforeEach(() => {
  __setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);
});
afterEach(() => {
  global.fetch = originalFetch;
  __clearCitationCacheForTests();
  __setDnsLookupForTests(null);
});

/** One citation: its source resolves, and the judge answers with this reply text. Returns how many requests were made in all. */
function sourceThenJudge(replyText: string): { requests: () => number } {
  let call = 0;
  global.fetch = vi.fn(async () => {
    call += 1;
    if (call === 1) return new Response('The retry limit is five attempts.', { headers: { 'content-type': 'text/plain' } });
    return new Response(JSON.stringify({ id: 'm', content: [{ type: 'text', text: replyText }], usage: { input_tokens: 50, output_tokens: 10 } }));
  }) as typeof fetch;
  return { requests: () => call };
}

/** The same, with the judge answering as OpenAI's o1-mini, which offers no structured output and is asked in text. */
function sourceThenJudgeInText(replyText: string): { requests: () => number } {
  let call = 0;
  global.fetch = vi.fn(async () => {
    call += 1;
    if (call === 1) return new Response('The retry limit is five attempts.', { headers: { 'content-type': 'text/plain' } });
    return new Response(JSON.stringify({ id: 'c', choices: [{ message: { content: replyText }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } }));
  }) as typeof fetch;
  return { requests: () => call };
}

const verify = (): ReturnType<typeof verifyCitations> => verifyCitations({ output: 'The retry limit is five attempts https://a.com/retry.', provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k', allowFetch: true });
const verifyInText = (): ReturnType<typeof verifyCitations> => verifyCitations({ output: 'The retry limit is five attempts https://a.com/retry.', provider: 'openai', model: 'o1-mini', apiKey: 'k', allowFetch: true });

describe('a citation judge reply that gives no verdict is not read as one', () => {
  // What a reply can put where the verdict belongs. Each read as "not supported".
  it.each([
    ['left out', '{"confidence":0.9,"rationale":"r"}', 'no value'],
    ['null', '{"supported":null,"confidence":0.9,"rationale":"r"}', 'null'],
    ['"true" in quotes', '{"supported":"true","confidence":0.9,"rationale":"r"}', '"true"'],
    ['1', '{"supported":1,"confidence":0.9,"rationale":"r"}', '1'],
    ['"yes"', '{"supported":"yes","confidence":0.9,"rationale":"r"}', '"yes"'],
    ['a list', '{"supported":[true],"confidence":0.9,"rationale":"r"}', '[true]'],
  ])('a verdict that is %s: the citation is not judged, and the output is not failed for it', async (_what, replyText, shown) => {
    const judge = sourceThenJudge(replyText);
    const result = await verify();
    expect(result.totalResolved).toBe(1);
    expect(result.totalJudged).toBe(0);
    expect(result.totalSupported).toBe(0);
    expect(result.citations[0].judge).toBeUndefined();
    expect(result.citations[0].judgeError?.kind).toBe('malformed_judge_response');
    // The message says what stood where the verdict belongs.
    expect(result.citations[0].judgeError?.message).toBe(`Citation judge gave no verdict: "supported" is ${shown}`);
    // Nothing was judged, so there is no verdict: not a fail, which is what "not supported" gave.
    expect(result.passed).toBeNull();
    expect(result.overallScore).toBeNull();
    // The judge was asked once (one request for the source, one for the judge), and that call is counted.
    expect(judge.requests()).toBe(2);
    expect(result.totalCostUsd).toBe(0.0001);
  });

  // What a reply can put where the confidence belongs, beside a verdict either way. Number() makes 0 of the first four and 1 of the fifth.
  const NOT_A_CONFIDENCE: Array<[json: string, shown: string]> = [
    ['null', 'null'],
    ['false', 'false'],
    ['""', '""'],
    ['[]', '[]'],
    ['true', 'true'],
    ['"0.9"', '"0.9"'],
    ['[0.9]', '[0.9]'],
    ['1.5', '1.5'],
    ['-0.1', '-0.1'],
    ['1.004', '1.004'],
    ['1e400', 'Infinity'],
  ];
  it.each(NOT_A_CONFIDENCE.flatMap(([json, shown]) => [true, false].map((supported) => [json, supported, shown] as [string, boolean, string])))(
    'a confidence of %s beside supported %s: the citation is not judged',
    async (confidence, supported, shown) => {
      sourceThenJudge(`{"supported":${supported},"confidence":${confidence},"rationale":"r"}`);
      const result = await verify();
      expect(result.totalJudged).toBe(0);
      expect(result.citations[0].judge).toBeUndefined();
      expect(result.citations[0].judgeError?.kind).toBe('malformed_judge_response');
      expect(result.citations[0].judgeError?.message).toBe(`Citation judge confidence is not a number from 0 to 1: ${shown}`);
      expect(result.passed).toBeNull();
    },
  );

  it('a verdict the reply does give is read as given, either way, with a confidence at either end of the range', async () => {
    sourceThenJudge('{"supported":false,"confidence":0,"rationale":"The source does not mention it."}');
    const against = await verify();
    expect(against.totalJudged).toBe(1);
    expect(against.totalSupported).toBe(0);
    expect(against.citations[0].judge).toMatchObject({ supported: false, confidence: 0 });
    expect(against.passed).toBe(false);
    __clearCitationCacheForTests();
    sourceThenJudge('{"supported":true,"confidence":1,"rationale":"It says five attempts."}');
    const supported = await verify();
    expect(supported.totalJudged).toBe(1);
    expect(supported.totalSupported).toBe(1);
    expect(supported.citations[0].judge).toMatchObject({ supported: true, confidence: 1 });
    expect(supported.passed).toBe(true);
  });

  it('a confidence is rounded to two decimals, as before', async () => {
    sourceThenJudge('{"supported":true,"confidence":0.846,"rationale":"r"}');
    expect((await verify()).citations[0].judge).toMatchObject({ supported: true, confidence: 0.85 });
  });
});

const OBJECT = '{"supported":true,"confidence":0.9,"rationale":"It says five attempts."}';
const AROUND: Array<[string, string]> = [
  ['a code fence around the object', `\`\`\`json\n${OBJECT}\n\`\`\``],
  ['a sentence before the object', `My verdict:\n${OBJECT}`],
  ['a sentence after the object', `${OBJECT}\nI hope that helps.`],
];
const NO_OBJECT: Array<[string, string]> = [
  ['no object at all', 'I cannot answer in the requested format.'],
  ['text that is not JSON between its braces', '{"supported": true, "confidence": 0.9, "rationale": "r" oops}'],
  ['two objects', `${OBJECT}\n${OBJECT}`],
];

describe("asked for as structured output, the citation judge's reply is the object alone, read whole", () => {
  it('the object alone: the verdict is read', async () => {
    const judge = sourceThenJudge(OBJECT);
    const result = await verify();
    expect(result.totalJudged).toBe(1);
    expect(result.citations[0].judge).toMatchObject({ supported: true, confidence: 0.9 });
    expect(judge.requests()).toBe(2);
  });

  it.each([...AROUND, ...NO_OBJECT, ['an object quoted before the answer', `The page says {"supported":false,"confidence":1,"rationale":"x"} but ${OBJECT}`]])(
    '%s: the citation is not judged, and the judge is asked once',
    async (_what, replyText) => {
      const judge = sourceThenJudge(replyText);
      const result = await verify();
      expect(result.totalJudged).toBe(0);
      expect(result.citations[0].judge).toBeUndefined();
      expect(result.citations[0].judgeError?.kind).toBe('malformed_judge_response');
      expect(result.citations[0].judgeError?.message).toBe(`Citation judge reply is not the JSON object it was asked for: ${replyText.slice(0, 200)}`);
      expect(result.passed).toBeNull();
      expect(judge.requests()).toBe(2);
    },
  );
});

describe("from a model that offers no structured output, the citation judge's object is read from the reply's first brace to its last, as before", () => {
  it.each([['the object alone', OBJECT], ...AROUND])('%s: the verdict is read', async (_what, replyText) => {
    const judge = sourceThenJudgeInText(replyText);
    const result = await verifyInText();
    expect(result.totalJudged).toBe(1);
    expect(result.citations[0].judge).toMatchObject({ supported: true, confidence: 0.9 });
    expect(judge.requests()).toBe(2);
  });

  it.each(NO_OBJECT)('%s: the citation is not judged, and the judge is asked once', async (_what, replyText) => {
    const judge = sourceThenJudgeInText(replyText);
    const result = await verifyInText();
    expect(result.totalJudged).toBe(0);
    expect(result.citations[0].judge).toBeUndefined();
    expect(result.citations[0].judgeError?.kind).toBe('malformed_judge_response');
    expect(result.citations[0].judgeError?.message).toBe(`Citation judge reply holds no JSON object: ${replyText.slice(0, 200)}`);
    expect(result.passed).toBeNull();
    expect(judge.requests()).toBe(2);
  });
});
