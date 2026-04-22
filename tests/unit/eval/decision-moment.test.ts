import { describe, it, expect } from 'vitest';
import { deriveMoment, deriveMomentDetail } from '../../../src/eval/decision-moment.js';
import type { Trace } from '../../../src/types/trace.js';
import type { EvalResult } from '../../../src/types/eval.js';

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

describe('deriveMoment', () => {
  it('returns unevaluated verdict when no evals exist', () => {
    const m = deriveMoment(makeTrace(), []);
    expect(m.verdict).toBe('unevaluated');
    expect(m.evalCount).toBe(0);
    expect(m.significance.kind).toBe('normal-pass');
    expect(m.significance.label).toBe('No eval recorded');
  });

  it('returns pass verdict when all rules pass', () => {
    const m = deriveMoment(makeTrace(), [
      makeEval({
        rule_results: [
          { ruleName: 'no_pii', passed: true, score: 1, message: 'No PII detected' },
          { ruleName: 'min_output_length', passed: true, score: 1, message: 'OK' },
        ],
      }),
    ]);
    expect(m.verdict).toBe('pass');
    expect(m.ruleSnapshot.passedCount).toBe(2);
    expect(m.ruleSnapshot.failed).toEqual([]);
    expect(m.significance.kind).toBe('normal-pass');
  });

  it('elevates safety-rule failure to safety-violation significance', () => {
    const m = deriveMoment(makeTrace(), [
      makeEval({
        passed: false,
        rule_results: [
          { ruleName: 'no_pii', passed: false, score: 0, message: 'SSN detected' },
        ],
      }),
    ]);
    expect(m.significance.kind).toBe('safety-violation');
    expect(m.significance.score).toBe(1.0);
    expect(m.significance.label).toContain('no_pii');
    expect(m.verdict).toBe('fail');
  });

  it('classifies cost-spike when trace cost crosses absolute threshold', () => {
    const m = deriveMoment(
      makeTrace({ cost_usd: 0.15 }),
      [
        makeEval({
          rule_results: [
            { ruleName: 'min_output_length', passed: true, score: 1, message: 'OK' },
          ],
        }),
      ],
    );
    expect(m.significance.kind).toBe('cost-spike');
    expect(m.significance.label).toContain('0.15');
  });

  it('safety-violation outranks cost-spike', () => {
    const m = deriveMoment(
      makeTrace({ cost_usd: 0.5 }),
      [
        makeEval({
          passed: false,
          rule_results: [
            { ruleName: 'no_pii', passed: false, score: 0, message: 'SSN found' },
          ],
        }),
      ],
    );
    expect(m.significance.kind).toBe('safety-violation');
  });

  it('classifies rule-collision when failures span multiple eval_types', () => {
    const m = deriveMoment(makeTrace(), [
      makeEval({
        id: 'eval-completeness',
        eval_type: 'completeness',
        passed: false,
        rule_results: [
          { ruleName: 'min_output_length', passed: false, score: 0, message: 'Too short' },
        ],
      }),
      makeEval({
        id: 'eval-relevance',
        eval_type: 'relevance',
        passed: false,
        rule_results: [
          { ruleName: 'keyword_overlap', passed: false, score: 0, message: 'No overlap' },
        ],
      }),
    ]);
    expect(m.significance.kind).toBe('rule-collision');
    expect(m.significance.label).toContain('Multi-category');
    expect(m.ruleSnapshot.failed).toHaveLength(2);
  });

  it('returns partial verdict when mix of pass/fail', () => {
    const m = deriveMoment(makeTrace(), [
      makeEval({
        passed: false,
        rule_results: [
          { ruleName: 'min_output_length', passed: true, score: 1, message: 'OK' },
          { ruleName: 'sentence_count', passed: false, score: 0, message: 'Too few' },
        ],
      }),
    ]);
    expect(m.verdict).toBe('partial');
  });

  it('counts skipped rules separately from passed and failed', () => {
    const m = deriveMoment(makeTrace(), [
      makeEval({
        rule_results: [
          { ruleName: 'min_output_length', passed: true, score: 1, message: 'OK' },
          {
            ruleName: 'keyword_overlap',
            passed: true,
            score: 1,
            message: 'No input',
            skipped: true,
            skipReason: 'context.input not provided',
          },
        ],
      }),
    ]);
    expect(m.ruleSnapshot.passedCount).toBe(1);
    expect(m.ruleSnapshot.skipped).toEqual(['keyword_overlap']);
    expect(m.ruleSnapshot.failed).toEqual([]);
  });
});

describe('deriveMomentDetail', () => {
  it('includes evals + tool_calls + spans', () => {
    const trace = makeTrace({
      tool_calls: [{ tool_name: 'search', input: 'q', output: 'r' }],
    });
    const evals = [
      makeEval({
        rule_results: [
          { ruleName: 'no_pii', passed: true, score: 1, message: 'No PII' },
        ],
        suggestions: ['Looks clean'],
      }),
    ];
    const spans = [
      {
        span_id: 's1',
        name: 'root',
        kind: 'INTERNAL' as const,
        start_time: '2026-04-22T20:00:00.000Z',
      },
    ];
    const detail = deriveMomentDetail(trace, evals, spans as never);
    expect(detail.evals).toHaveLength(1);
    expect(detail.evals[0].ruleResults[0].ruleName).toBe('no_pii');
    expect(detail.evals[0].suggestions).toEqual(['Looks clean']);
    expect(detail.toolCalls?.[0].tool_name).toBe('search');
    expect(detail.spans?.[0].span_id).toBe('s1');
  });
});
