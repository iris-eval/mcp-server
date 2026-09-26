/*
 * The sandbox budget counts matching, not waiting (#677).
 *
 * Until 0.20.0 the budget ran from the moment a match was posted, so the
 * time the worker thread waited to be scheduled was charged to the
 * pattern. On a busy host a trivial `forbidden` on a 40-character output
 * was killed as backtracking, and a critical custom rule came back skipped.
 * A test hook makes the worker wait before it starts each match, the way a
 * thread waits on a host too busy to schedule it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  __setSandboxStartDelayForTests,
  sandboxedRegexTest,
  shutdownRegexSandbox,
  REGEX_MATCH_BUDGET_MS,
} from '../../../src/eval/rules/regex-sandbox.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { createCustomRule } from '../../../src/eval/rules/custom.js';

const HOSTILE_PATTERN = '^(a|a)*$'; // lgtm[js/redos] — intentionally hostile test input
const HOSTILE_INPUT = 'a'.repeat(40) + 'b';
/** Three budgets of waiting before the match starts. */
const BUSY_MS = 3 * REGEX_MATCH_BUDGET_MS;

afterEach(() => {
  __setSandboxStartDelayForTests(0);
  shutdownRegexSandbox();
});

describe('regex sandbox on a busy host', () => {
  it('a trivial pattern that waits three budgets to be scheduled still answers', () => {
    __setSandboxStartDelayForTests(BUSY_MS);
    const started = performance.now();
    const outcome = sandboxedRegexTest('forbidden', '', 'this response contains a forbidden token');
    expect(performance.now() - started).toBeGreaterThanOrEqual(BUSY_MS - 5);
    expect(outcome).toMatchObject({ kind: 'match', matched: true });
  });

  it('a catastrophic pattern is still killed, a budget after it starts', () => {
    __setSandboxStartDelayForTests(BUSY_MS);
    const started = performance.now();
    const outcome = sandboxedRegexTest(HOSTILE_PATTERN, '', HOSTILE_INPUT);
    const elapsed = performance.now() - started;
    expect(outcome).toEqual({ kind: 'timeout' });
    // The wait before the match plus the budget: it ran its full budget and
    // no more (2^40 steps would take hours).
    expect(elapsed).toBeGreaterThanOrEqual(BUSY_MS + REGEX_MATCH_BUDGET_MS - 5);
  });

  it('with no wait, a catastrophic pattern is killed at the budget as before', () => {
    const started = performance.now();
    expect(sandboxedRegexTest(HOSTILE_PATTERN, '', HOSTILE_INPUT)).toEqual({ kind: 'timeout' });
    expect(performance.now() - started).toBeGreaterThanOrEqual(REGEX_MATCH_BUDGET_MS - 5);
  });

  it('a critical custom rule still judges, and vetoes, on a busy host', async () => {
    __setSandboxStartDelayForTests(BUSY_MS);
    const engine = new EvalEngine(0.7);
    engine.registerRule(
      'custom',
      createCustomRule({ name: 'linear_forbidden', type: 'regex_no_match', config: { pattern: 'forbidden' } }, 'critical'),
      'rule-busy',
    );
    const result = await engine.evaluate('custom', { output: 'this response contains a forbidden token' });
    expect(result.critical_skipped).toBeUndefined();
    expect(result.critical_failures).toEqual(['linear_forbidden']);
    expect(result.passed).toBe(false);
  });
});
