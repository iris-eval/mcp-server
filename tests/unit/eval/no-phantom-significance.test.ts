import { describe, it, expect } from 'vitest';
import { deriveMoment, historyBefore } from '../../../src/eval/decision-moment.js';
import type { Trace } from '../../../src/types/trace.js';
import type { EvalResult } from '../../../src/types/eval.js';
import type { MomentSignificanceKind } from '../../../src/types/decision-moment.js';

/*
 * Every value the moments filter accepts must be a value the classifier can
 * actually produce.
 *
 * `first-failure` and `novel-pattern` were filter options from v0.4 to
 * 0.11.0 and the classifier could never emit either — the code's own header
 * said so and pointed at a version that never shipped them. Selecting one
 * returned an empty list forever, which is indistinguishable from "you have
 * no such moments" and is the worse of the two readings.
 *
 * This test is the guard that was missing: it does not check a list against
 * a list, it DRIVES the classifier to each kind. A filter value nothing can
 * produce fails here, and so does a kind that quietly stops being reachable.
 */

const KINDS_THE_FILTER_ACCEPTS: MomentSignificanceKind[] = [
  'safety-violation',
  'cost-spike',
  'first-failure',
  'novel-pattern',
  'rule-collision',
  'normal-pass',
  'normal-fail',
];

const trace = (over: Partial<Trace> = {}): Trace => ({
  trace_id: 'subject',
  agent_name: 'runner',
  input: 'ask',
  output: 'answer',
  timestamp: '2026-09-07T12:00:00Z',
  ...over,
});

const evalOf = (rules: string[], passed: boolean, evalType = 'completeness'): EvalResult => ({
  id: `e-${evalType}`,
  trace_id: 'subject',
  eval_type: evalType as EvalResult['eval_type'],
  output_text: 'answer',
  score: passed ? 0.9 : 0.2,
  passed,
  rule_results: rules.map((ruleName) => ({ ruleName, passed: false, score: 0, message: 'failed' })),
  suggestions: [],
});

/** Five quiet prior traces: enough history for the novelty classes to speak. */
const quietHistory = (failedBefore: string[][] = [[], [], [], [], []]) =>
  historyBefore(
    failedBefore.map((failed, i) => ({ traceId: `t${i}`, timestamp: `2026-09-0${i + 1}T09:00:00Z`, failed: [...failed].sort() })),
    'subject',
    '2026-09-07T12:00:00Z',
  );

/** One producer per kind. Adding a filter value means adding a producer here. */
const PRODUCERS: Record<MomentSignificanceKind, () => MomentSignificanceKind> = {
  'safety-violation': () => deriveMoment(trace(), [evalOf(['no_pii'], false)]).significance.kind,
  'cost-spike': () => deriveMoment(trace({ cost_usd: 5 }), [evalOf([], true)]).significance.kind,
  'first-failure': () =>
    deriveMoment(trace(), [evalOf(['keyword_overlap'], false)], quietHistory()).significance.kind,
  'novel-pattern': () =>
    deriveMoment(
      trace(),
      [evalOf(['keyword_overlap', 'min_output_length'], false)],
      quietHistory([['keyword_overlap'], ['min_output_length'], [], [], []]),
    ).significance.kind,
  'rule-collision': () =>
    deriveMoment(trace(), [evalOf(['keyword_overlap'], false, 'relevance'), evalOf(['min_output_length'], false, 'completeness')])
      .significance.kind,
  'normal-fail': () => deriveMoment(trace(), [evalOf(['keyword_overlap'], false)]).significance.kind,
  'normal-pass': () => deriveMoment(trace(), [evalOf([], true)]).significance.kind,
};

describe('no filter value is a phantom', () => {
  it.each(KINDS_THE_FILTER_ACCEPTS)('the classifier can actually emit %s', (kind) => {
    expect(PRODUCERS[kind]()).toBe(kind);
  });

  it('has a producer for every kind the filter accepts, so a new option cannot skip this test', () => {
    expect(Object.keys(PRODUCERS).sort()).toEqual([...KINDS_THE_FILTER_ACCEPTS].sort());
  });
});
