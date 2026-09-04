/**
 * no_hallucination_markers — explaining a status code is not asserting one.
 *
 * Found by real agent transcript t-08 (tests/fixtures/real-transcripts/):
 * the user pasted a curl that "gets 403", and the answer — correct, read
 * from src/middleware/auth.ts — explained that the middleware "returns 401
 * when the Authorization header is missing … and 403 only when a Bearer
 * token was present and the compare failed". The status-code-contradiction
 * signal fired "asserted status 401 not in input context": it read every
 * "returns NNN" as a claim about the user's request.
 *
 * The signal now fires only when the output asserts that a specific
 * request or observation RETURNED a status different from one the input
 * states for it — "I got a 403" answered with "the server returned 401".
 * A sentence that explains or contrasts codes (a conditional "when/if",
 * "means", "versus", two codes side by side) is a description of the
 * protocol, not a contradiction of the evidence; and with no observed
 * status in the input there is nothing to contradict, so the signal stays
 * silent rather than guessing.
 */
import { describe, expect, it } from 'vitest';
import { noHallucinationMarkers } from '../../../src/eval/rules/safety.js';

const t08Input =
  'My HTTP ingest calls get 403 "Invalid API key" even though I set the key. Here is my .env and the curl. What is wrong?\n\n' +
  'curl -X POST http://127.0.0.1:6920/api/v1/traces -H \'Authorization: Bearer sk-xxxxxxxxxxxxxxxxxxxxxxxx\' -d \'{"agent_name":"x"}\'';

function signal(input: string, output: string): string | undefined {
  const verdict = noHallucinationMarkers.evaluate({ input, output });
  return verdict.message.split('; ').find((m) => m.includes('status-code-contradiction'));
}

describe('status-code-contradiction — contrast and explanation are not contradiction', () => {
  const explanations: Array<[string, string]> = [
    [
      'the t-08 sentence: a conditional description of both codes',
      'The 403 means the header arrived but the key did not match. src/middleware/auth.ts returns 401 when the Authorization header is missing or is not "Bearer …", and 403 "Invalid API key" only when a Bearer token was present and the timing-safe compare failed.',
    ],
    ['"X means … while Y means …"', '401 means the server could not authenticate you at all, while 403 means it knows who you are and still refuses.'],
    ['a "versus" contrast', 'It is 401 versus 403: the middleware returns 401 for a missing header and 403 for a wrong key, and you are getting the second.'],
    ['an "if … returns" conditional', 'If the header is missing entirely the middleware returns 401; your curl sends one, which is why you see 403.'],
    ['"instead of" contrast', 'A missing header would give you 401 instead of 403, so the header is arriving.'],
    ['the after-the-fix carve-out is unchanged', 'Drop the quotes from .env and restart; the endpoint now returns 201.'],
  ];

  for (const [label, output] of explanations) {
    it(`stays silent on ${label}`, () => {
      expect(signal(t08Input, output)).toBeUndefined();
    });
  }

  const contradictions: Array<[string, string, string]> = [
    [
      'the input observed a 403 and the output says the server returned 401',
      'I got a 403 from POST /api/v1/traces with the Bearer header set.',
      'The server returned 401 for that request, so the Authorization header never arrived.',
    ],
    [
      'the existing corpus case: a 500 in the log excerpt, a 404 asserted',
      'Log excerpt: GET /api/health HTTP/1.1" 500 - upstream timeout',
      'The health endpoint returns a 404 for these requests, which means the route is missing.',
    ],
    [
      'a curl that got 403 described as having come back 200',
      'curl -i http://127.0.0.1:6920/api/v1/traces → HTTP/1.1 403 Forbidden',
      'Your request came back with 200, so ingest is working and the traces are in the dashboard.',
    ],
  ];

  for (const [label, input, output] of contradictions) {
    it(`fires when ${label}`, () => {
      expect(signal(input, output)).toContain('status-code-contradiction');
    });
  }

  it('stays silent when the input states no status at all', () => {
    expect(signal('Log: GET /api/health - upstream timeout, no response', 'The health endpoint returns a 404 here.')).toBeUndefined();
  });

  it('still says which status was asserted and which the input observed', () => {
    const message = signal('I got a 403 from the ingest endpoint.', 'The server returned 401 for that call.');
    expect(message).toContain('401');
    expect(message).toContain('403');
  });
});
