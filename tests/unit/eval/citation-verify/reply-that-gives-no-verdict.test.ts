/*
 * The citation judge's reply is read as a verdict only when it gives one.
 *
 * The judge is asked for `"supported": <boolean>` and a confidence from 0
 * to 1. The verdict used to be read as `supported === true`, so a reply that
 * left it out, or gave `null`, or gave `"true"` in quotes, read as "not
 * supported": a verdict against the citation, from a reply that made none,
 * and `passed: false` for the whole output. The confidence was converted
 * with Number(), which reads `null` as 0 and `true` as 1. Either is a
 * malformed reply: the citation is reported as not judged, and takes no
 * part in the verdict.
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

/** One citation: its source resolves, and the judge answers with this reply text. */
function sourceThenJudge(replyText: string): void {
  let call = 0;
  global.fetch = vi.fn(async () => {
    call += 1;
    if (call === 1) return new Response('The retry limit is five attempts.', { headers: { 'content-type': 'text/plain' } });
    return new Response(JSON.stringify({ id: 'm', content: [{ type: 'text', text: replyText }], usage: { input_tokens: 50, output_tokens: 10 } }));
  }) as typeof fetch;
}

const verify = (): ReturnType<typeof verifyCitations> => verifyCitations({ output: 'The retry limit is five attempts https://a.com/retry.', provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k', allowFetch: true });

describe('a citation judge reply that gives no verdict is not read as one', () => {
  // What a reply can put where the verdict belongs. Each read as "not supported".
  it.each([['left out', '{"confidence":0.9,"rationale":"r"}'], ['null', '{"supported":null,"confidence":0.9,"rationale":"r"}'], ['"true" in quotes', '{"supported":"true","confidence":0.9,"rationale":"r"}'], ['1', '{"supported":1,"confidence":0.9,"rationale":"r"}'], ['"yes"', '{"supported":"yes","confidence":0.9,"rationale":"r"}'], ['a list', '{"supported":[true],"confidence":0.9,"rationale":"r"}']])(
    'a verdict that is %s: the citation is not judged, and the output is not failed for it',
    async (_what, replyText) => {
      sourceThenJudge(replyText);
      const result = await verify();
      expect(result.totalResolved).toBe(1);
      expect(result.totalJudged).toBe(0);
      expect(result.totalSupported).toBe(0);
      expect(result.citations[0].judge).toBeUndefined();
      expect(result.citations[0].judgeError?.kind).toBe('malformed_judge_response');
      expect(result.citations[0].judgeError?.message).toContain('gave no verdict');
      // Nothing was judged, so there is no verdict: not a fail, which is what "not supported" gave.
      expect(result.passed).toBeNull();
      expect(result.overallScore).toBeNull();
    },
  );

  // What a reply can put where the confidence belongs. Number() makes 0 of the first four and 1 of the fifth.
  it.each(['null', 'false', '""', '[]', 'true', '"0.9"', '[0.9]', '1.5', '-0.1'])('a confidence of %s: the citation is not judged', async (confidence) => {
    sourceThenJudge(`{"supported":true,"confidence":${confidence},"rationale":"r"}`);
    const result = await verify();
    expect(result.totalJudged).toBe(0);
    expect(result.citations[0].judge).toBeUndefined();
    expect(result.citations[0].judgeError?.kind).toBe('malformed_judge_response');
    expect(result.citations[0].judgeError?.message).toContain('confidence is not a number from 0 to 1');
    expect(result.passed).toBeNull();
  });

  it('a reply that is not valid JSON between its braces is malformed, and says so', async () => {
    sourceThenJudge('{"supported": true, "confidence": 0.9, "rationale": "r" oops}');
    const result = await verify();
    expect(result.totalJudged).toBe(0);
    expect(result.citations[0].judgeError?.kind).toBe('malformed_judge_response');
    expect(result.citations[0].judgeError?.message).toContain('not valid JSON');
  });

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
});
