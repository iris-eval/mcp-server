import { describe, it, expect } from 'vitest';
import { deriveMoment } from '../../../src/eval/decision-moment.js';
import { safetyRules } from '../../../src/eval/rules/safety.js';
import type { Trace } from '../../../src/types/trace.js';
import type { EvalResult } from '../../../src/types/eval.js';

/*
 * The moment classifier's safety set must be the safety BUNDLE, not a copy
 * of it. It was a hand-typed list of v0.3.1's four names; v0.5.0 moved
 * no_hallucination_markers into `safetyRules` and the list was never
 * touched, so a trace whose only failing rule was a fabricated citation
 * classified as `normal-fail` (significance 0.5) instead of
 * `safety-violation` (1.0) and ranked below plain failures on the
 * failure-first landing page. Deriving the set from `safetyRules` closes
 * the gap for every rule the bundle holds now and later.
 */

function makeTrace(): Trace {
  return {
    trace_id: 'trace-1',
    agent_name: 'test-agent',
    timestamp: '2026-04-22T20:00:00.000Z',
    input: 'Hello',
    output: 'Hi there',
    cost_usd: 0.001,
    latency_ms: 250,
  };
}

function failingEval(ruleName: string): EvalResult {
  return {
    id: 'eval-1',
    trace_id: 'trace-1',
    eval_type: 'safety',
    output_text: 'Hi there',
    score: 0.5,
    passed: false,
    rule_results: [{ ruleName, passed: false, score: 0, message: 'failed' }],
    suggestions: [],
  };
}

describe('safety-violation classification tracks the safety bundle', () => {
  it('a no_hallucination_markers failure is a safety violation', () => {
    const m = deriveMoment(makeTrace(), [failingEval('no_hallucination_markers')]);
    expect(m.significance.kind).toBe('safety-violation');
    expect(m.significance.score).toBe(1.0);
    expect(m.significance.label).toContain('no_hallucination_markers');
  });

  it('every rule in safetyRules classifies as a safety violation when it fails', () => {
    expect(safetyRules.length).toBeGreaterThanOrEqual(5);
    for (const rule of safetyRules) {
      const m = deriveMoment(makeTrace(), [failingEval(rule.name)]);
      expect(m.significance.kind, rule.name).toBe('safety-violation');
    }
  });

  it('a non-safety rule failure still classifies as a plain fail', () => {
    const m = deriveMoment(makeTrace(), [failingEval('keyword_overlap')]);
    expect(m.significance.kind).toBe('normal-fail');
  });
});
