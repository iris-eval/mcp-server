/**
 * verify_citations fails CLOSED when citations resolved and the judge then
 * failed on every one (v0.6.0 acceptance pass, observation 3). Before this
 * guard a wrong API key produced `passed: true, overall_score: null` with
 * the auth error filed per citation — a verdict a caller would ship on.
 */
import { describe, it, expect } from 'vitest';
import { assertJudgeRan } from '../../../src/tools/verify-citations.js';

const authFailed = { resolveStatus: 'ok', resolveError: { kind: 'auth', message: 'Anthropic API returned 401: invalid x-api-key' } };
const judged = { resolveStatus: 'ok' };
const unresolved = { resolveStatus: 'fetch_failed', resolveError: { kind: 'network', message: 'ECONNREFUSED' } };

describe('assertJudgeRan', () => {
  it('throws, naming the cause, when every resolved citation failed at the judge', () => {
    expect(() => assertJudgeRan({ totalResolved: 2, totalJudged: 0, citations: [authFailed, authFailed] })).toThrow(
      /could not judge any of the 2 resolved citation\(s\).*\(auth\).*Nothing was verified and nothing was stored.*invalid x-api-key/,
    );
  });

  it('is silent when the judge ruled on at least one citation', () => {
    expect(() => assertJudgeRan({ totalResolved: 2, totalJudged: 1, citations: [judged, authFailed] })).not.toThrow();
  });

  it('is silent when nothing resolved — "nothing to judge" is the honest null verdict', () => {
    expect(() => assertJudgeRan({ totalResolved: 0, totalJudged: 0, citations: [unresolved] })).not.toThrow();
    expect(() => assertJudgeRan({ totalResolved: 0, totalJudged: 0, citations: [] })).not.toThrow();
  });
});
