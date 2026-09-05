import { describe, it, expect } from 'vitest';
import { deriveMoment } from '../../../src/eval/decision-moment.js';
import {
  isFailureMoment,
  rankFailureScore,
  FAILURE_RANK_HALF_LIFE_MS,
} from '../../../src/eval/failure-rank.js';
import type { Trace } from '../../../src/types/trace.js';
import type { EvalResult } from '../../../src/types/eval.js';

/*
 * Moments are built through deriveMoment (the production classifier), not
 * hand-assembled — so these tests break if the classifier's verdicts or
 * significance scores drift out from under the ranking logic.
 */

function makeTrace(overrides: Partial<Trace> = {}): Trace {
  return {
    trace_id: 'trace-1',
    agent_name: 'test-agent',
    timestamp: '2026-04-22T20:00:00.000Z',
    input: 'Hello',
    output: 'Hi there',
    cost_usd: 0.001,
    latency_ms: 250,
    ...overrides,
  };
}

function makeEval(overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    id: 'eval-1',
    trace_id: 'trace-1',
    eval_type: 'safety',
    output_text: 'Hi there',
    score: 1,
    passed: true,
    rule_results: [],
    suggestions: [],
    ...overrides,
  };
}

const passingEval = () =>
  makeEval({
    rule_results: [{ ruleName: 'min_output_length', passed: true, score: 1, message: 'OK' }],
  });

const failingEval = () =>
  makeEval({
    passed: false,
    score: 0,
    rule_results: [{ ruleName: 'min_output_length', passed: false, score: 0, message: 'Too short' }],
  });

describe('isFailureMoment', () => {
  it('includes fail verdicts', () => {
    const m = deriveMoment(makeTrace(), [failingEval()]);
    expect(m.verdict).toBe('fail');
    expect(isFailureMoment(m)).toBe(true);
  });

  it('includes partial verdicts — two evaluations of one trace that disagree', () => {
    const m = deriveMoment(makeTrace(), [
      makeEval({ passed: true, rule_results: [{ ruleName: 'no_blocklist_check', passed: true, score: 1, message: 'OK' }] }),
      makeEval({ passed: false, rule_results: [{ ruleName: 'min_output_length', passed: false, score: 0, message: 'Too short' }] }),
    ]);
    expect(m.verdict).toBe('partial');
    expect(isFailureMoment(m)).toBe(true);
  });

  it('flags a cost spike even when the verdict is pass', () => {
    const m = deriveMoment(makeTrace({ cost_usd: 0.15 }), [passingEval()]);
    expect(m.verdict).toBe('pass');
    expect(m.significance.kind).toBe('cost-spike');
    expect(isFailureMoment(m)).toBe(true);
  });

  it('excludes clean passes', () => {
    const m = deriveMoment(makeTrace(), [passingEval()]);
    expect(m.verdict).toBe('pass');
    expect(isFailureMoment(m)).toBe(false);
  });

  it('excludes unevaluated traces', () => {
    const m = deriveMoment(makeTrace(), []);
    expect(m.verdict).toBe('unevaluated');
    expect(isFailureMoment(m)).toBe(false);
  });
});

describe('rankFailureScore', () => {
  const now = Date.parse('2026-04-23T20:00:00.000Z');

  it('equals the significance score at age zero', () => {
    const m = deriveMoment(
      makeTrace({ timestamp: new Date(now).toISOString() }),
      [failingEval()],
    );
    expect(rankFailureScore(m, now)).toBeCloseTo(m.significance.score, 10);
  });

  it('halves per half-life elapsed', () => {
    const oneHalfLifeAgo = new Date(now - FAILURE_RANK_HALF_LIFE_MS).toISOString();
    const twoHalfLivesAgo = new Date(now - 2 * FAILURE_RANK_HALF_LIFE_MS).toISOString();
    const m1 = deriveMoment(makeTrace({ timestamp: oneHalfLifeAgo }), [failingEval()]);
    const m2 = deriveMoment(makeTrace({ timestamp: twoHalfLivesAgo }), [failingEval()]);
    expect(rankFailureScore(m1, now)).toBeCloseTo(m1.significance.score / 2, 10);
    expect(rankFailureScore(m2, now)).toBeCloseTo(m2.significance.score / 4, 10);
  });

  it('clamps future timestamps to age zero instead of inflating', () => {
    const future = new Date(now + FAILURE_RANK_HALF_LIFE_MS).toISOString();
    const m = deriveMoment(makeTrace({ timestamp: future }), [failingEval()]);
    expect(rankFailureScore(m, now)).toBeCloseTo(m.significance.score, 10);
  });

  it('ranks a fresh plain fail above a days-old safety violation', () => {
    // The design call: this is a "since you last looked" surface, so old
    // severity is history, not news. Three days of decay (score 1.0 →
    // 0.125) drops below a one-hour-old normal-fail (score 0.5 → ~0.486).
    const staleSafety = deriveMoment(
      makeTrace({ timestamp: new Date(now - 3 * FAILURE_RANK_HALF_LIFE_MS).toISOString() }),
      [
        makeEval({
          passed: false,
          rule_results: [{ ruleName: 'no_pii', passed: false, score: 0, message: 'SSN detected' }],
        }),
      ],
    );
    const freshFail = deriveMoment(
      makeTrace({ timestamp: new Date(now - 60 * 60 * 1000).toISOString() }),
      [failingEval()],
    );
    expect(staleSafety.significance.kind).toBe('safety-violation');
    expect(rankFailureScore(freshFail, now)).toBeGreaterThan(rankFailureScore(staleSafety, now));
  });

  it('ranks a safety violation above a plain fail of the same age', () => {
    const ts = new Date(now - 60 * 60 * 1000).toISOString();
    const safety = deriveMoment(makeTrace({ timestamp: ts }), [
      makeEval({
        passed: false,
        rule_results: [{ ruleName: 'no_pii', passed: false, score: 0, message: 'SSN detected' }],
      }),
    ]);
    const plain = deriveMoment(makeTrace({ timestamp: ts }), [failingEval()]);
    expect(rankFailureScore(safety, now)).toBeGreaterThan(rankFailureScore(plain, now));
  });
});
