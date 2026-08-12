import { describe, it, expect, afterAll } from 'vitest';
import {
  sandboxedRegexTest,
  shutdownRegexSandbox,
  REGEX_MATCH_BUDGET_MS,
} from '../../../src/eval/rules/regex-sandbox.js';

/*
 * The sandbox is the safety boundary for user-supplied regex — not
 * safe-regex2 (star-height-only: judges `(a|a)*$` safe) and not the
 * deploy-time probe (needs an igniting payload, which cannot be guessed in
 * general). These tests use `^(a|a)*$` as the canonical hostile pattern: it
 * passes every static check and needs 2^n steps on 'a'.repeat(n)+'b', so 40
 * characters is ~10^12 steps — it either gets killed by the deadline or the
 * test times out, with no in-between.
 */

const HOSTILE_PATTERN = '^(a|a)*$'; // lgtm[js/redos] — intentionally hostile test input
const HOSTILE_INPUT = 'a'.repeat(40) + 'b';

afterAll(() => {
  shutdownRegexSandbox();
});

describe('regex sandbox', () => {
  it('returns match results for normal patterns', () => {
    expect(sandboxedRegexTest('hello\\s+world', '', 'hello  world')).toMatchObject({
      kind: 'match',
      matched: true,
    });
    expect(sandboxedRegexTest('hello\\s+world', '', 'goodbye')).toMatchObject({
      kind: 'match',
      matched: false,
    });
  });

  it('honors regex flags', () => {
    expect(sandboxedRegexTest('HELLO', 'i', 'hello world')).toMatchObject({
      kind: 'match',
      matched: true,
    });
  });

  it('kills an exponential pattern at the deadline instead of hanging', () => {
    const started = Date.now();
    const outcome = sandboxedRegexTest(HOSTILE_PATTERN, '', HOSTILE_INPUT, 100);
    const elapsed = Date.now() - started;

    expect(outcome).toEqual({ kind: 'timeout' });
    // 2^40 steps would run for hours; anything under a couple of seconds
    // proves the deadline (not completion) ended the match. The margin over
    // 100ms absorbs slow-CI scheduling of the wait/terminate round-trip.
    expect(elapsed).toBeLessThan(2000);
  });

  it('recovers after a timeout: the next call gets a fresh worker', () => {
    expect(sandboxedRegexTest(HOSTILE_PATTERN, '', HOSTILE_INPUT, 50)).toMatchObject({
      kind: 'timeout',
    });
    expect(sandboxedRegexTest('clean', '', 'a clean output')).toMatchObject({
      kind: 'match',
      matched: true,
    });
  });

  it('survives repeated attack calls without leaking hangs', () => {
    for (let i = 0; i < 3; i++) {
      const started = Date.now();
      expect(sandboxedRegexTest(HOSTILE_PATTERN, '', HOSTILE_INPUT, 50).kind).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(2000);
    }
    expect(sandboxedRegexTest('ok', '', 'ok')).toMatchObject({ kind: "match", matched: true });
  });

  it('reports error for a pattern that fails to compile in the worker', () => {
    expect(sandboxedRegexTest('[unclosed', '', 'anything')).toEqual({ kind: 'error' });
  });

  it('handles large inputs within the default budget for linear patterns', () => {
    const big = 'lorem ipsum '.repeat(50_000); // ~600KB
    const outcome = sandboxedRegexTest('\\bipsum\\b', '', big, REGEX_MATCH_BUDGET_MS);
    expect(outcome).toMatchObject({ kind: "match", matched: true });
  });

  it('can be shut down and lazily respawned', () => {
    shutdownRegexSandbox();
    expect(sandboxedRegexTest('x', '', 'x')).toMatchObject({ kind: "match", matched: true });
  });
});
