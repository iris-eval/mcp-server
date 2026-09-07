import { describe, it, expect } from 'vitest';
import { deriveMoment, historyBefore } from '../../../src/eval/decision-moment.js';
import type { Trace } from '../../../src/types/trace.js';
import type { EvalResult } from '../../../src/types/eval.js';
import type { AgentFailureLogEntry } from '../../../src/types/query.js';

/*
 * first-failure and novel-pattern have been declared since v0.4 and could
 * never fire: the classifier saw one trace and its own evaluations, and
 * novelty is not a property of a trace — it is a property of a trace against
 * a history. These tests are the history arriving.
 */

const trace = (over: Partial<Trace> = {}): Trace => ({
  trace_id: 'subject',
  agent_name: 'runner',
  input: 'ask',
  output: 'answer',
  timestamp: '2026-09-07T12:00:00Z',
  ...over,
});

const failing = (rules: string[]): EvalResult[] => [
  {
    id: 'e1',
    trace_id: 'subject',
    eval_type: 'completeness',
    output_text: 'answer',
    score: 0.2,
    passed: false,
    rule_results: rules.map((ruleName) => ({ ruleName, passed: false, score: 0, message: 'failed' })),
    suggestions: [],
  },
];

const log = (entries: Array<[string, string[]]>): AgentFailureLogEntry[] =>
  entries.map(([id, failed], i) => ({
    traceId: id,
    timestamp: `2026-09-0${i + 1}T09:00:00Z`,
    failed: [...failed].sort(),
  }));

describe('historyBefore', () => {
  it('counts only traces older than the one under test', () => {
    const h = historyBefore(
      [
        { traceId: 'older', timestamp: '2026-09-01T00:00:00Z', failed: ['a'] },
        { traceId: 'newer', timestamp: '2026-09-09T00:00:00Z', failed: ['b'] },
      ],
      'subject',
      '2026-09-07T12:00:00Z',
    );
    expect(h.priorTraces).toBe(1);
    // A later trace cannot make an earlier one look familiar.
    expect(h.rulesEverFailed).toEqual(['a']);
  });

  it('never counts a trace as part of its own history', () => {
    const h = historyBefore([{ traceId: 'subject', timestamp: '2026-09-01T00:00:00Z', failed: ['a'] }], 'subject', '2026-09-07T12:00:00Z');
    expect(h.priorTraces).toBe(0);
    expect(h.rulesEverFailed).toEqual([]);
  });
});

describe('first-failure', () => {
  it('fires when a rule fails for the first time on this agent', () => {
    const history = historyBefore(log([['t1', ['min_output_length']], ['t2', []], ['t3', []], ['t4', []], ['t5', []]]), 'subject', '2026-09-07T12:00:00Z');
    const m = deriveMoment(trace(), failing(['keyword_overlap']), history);
    expect(m.significance.kind).toBe('first-failure');
    expect(m.significance.label).toContain('keyword_overlap');
    expect(m.significance.reason).toContain('first time');
  });

  it('stays silent on a rule this agent has failed before', () => {
    const history = historyBefore(log([['t1', ['keyword_overlap']], ['t2', []], ['t3', []], ['t4', []], ['t5', []]]), 'subject', '2026-09-07T12:00:00Z');
    const m = deriveMoment(trace(), failing(['keyword_overlap']), history);
    expect(m.significance.kind).toBe('normal-fail');
  });

  it('stays silent on a brand-new agent, where every failure is the first', () => {
    // Four prior traces is below the floor. Without it, the first afternoon
    // of use would rank novelty above everything, which is exactly when the
    // ranking most needs to be about severity.
    const history = historyBefore(log([['t1', []], ['t2', []], ['t3', []], ['t4', []]]), 'subject', '2026-09-07T12:00:00Z');
    const m = deriveMoment(trace(), failing(['keyword_overlap']), history);
    expect(m.significance.kind).toBe('normal-fail');
  });

  it('never outranks a safety violation', () => {
    const history = historyBefore(log([['t1', []], ['t2', []], ['t3', []], ['t4', []], ['t5', []]]), 'subject', '2026-09-07T12:00:00Z');
    const m = deriveMoment(trace(), failing(['no_pii']), history);
    expect(m.significance.kind).toBe('safety-violation');
  });
});

describe('novel-pattern', () => {
  it('fires when familiar rules fail together for the first time', () => {
    const history = historyBefore(
      log([['t1', ['keyword_overlap']], ['t2', ['min_output_length']], ['t3', []], ['t4', []], ['t5', []]]),
      'subject',
      '2026-09-07T12:00:00Z',
    );
    const m = deriveMoment(trace(), failing(['keyword_overlap', 'min_output_length']), history);
    expect(m.significance.kind).toBe('novel-pattern');
    expect(m.significance.reason).toContain('never in the same trace');
  });

  it('yields to first-failure, which is the stronger signal in the same situation', () => {
    // A brand-new rule is necessarily also a new combination. Reporting the
    // combination would swallow the stronger finding.
    const history = historyBefore(log([['t1', ['keyword_overlap']], ['t2', []], ['t3', []], ['t4', []], ['t5', []]]), 'subject', '2026-09-07T12:00:00Z');
    const m = deriveMoment(trace(), failing(['keyword_overlap', 'min_output_length']), history);
    expect(m.significance.kind).toBe('first-failure');
  });

  it('stays silent on a combination already seen', () => {
    const history = historyBefore(
      log([['t1', ['keyword_overlap', 'min_output_length']], ['t2', []], ['t3', []], ['t4', []], ['t5', []]]),
      'subject',
      '2026-09-07T12:00:00Z',
    );
    const m = deriveMoment(trace(), failing(['min_output_length', 'keyword_overlap']), history);
    expect(m.significance.kind).toBe('normal-fail');
  });
});

describe('a caller with no history', () => {
  it('classifies exactly as it did before, so every existing call site is unchanged', () => {
    const m = deriveMoment(trace(), failing(['keyword_overlap']));
    expect(m.significance.kind).toBe('normal-fail');
  });
});
