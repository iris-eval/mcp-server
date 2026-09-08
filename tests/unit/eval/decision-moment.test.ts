import { describe, it, expect } from 'vitest';
import { deriveMoment, deriveMomentDetail } from '../../../src/eval/decision-moment.js';
import { MOMENT_SIGNIFICANCE_KINDS } from '../../../src/types/decision-moment.js';
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
    // D-0: nothing judged is its own kind, never a pass.
    expect(m.significance.kind).toBe('unevaluated');
    expect(m.significance.label).toBe('No verdict');
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

  it('one failed evaluation is a fail, whatever its rules did', () => {
    /*
     * "partial" used to mean "some rules failed inside one evaluation",
     * which from 0.10.0 contradicts the verdict that evaluation reached: a
     * rule can fail while the verdict passes, because a shipped default
     * only advises and weak evidence does not carry the risk past the loss
     * threshold. The moment shows the verdict; it does not compute a second.
     */
    const m = deriveMoment(makeTrace(), [
      makeEval({
        passed: false,
        rule_results: [
          { ruleName: 'min_output_length', passed: true, score: 1, message: 'OK' },
          { ruleName: 'sentence_count', passed: false, score: 0, message: 'Too few' },
        ],
      }),
    ]);
    expect(m.verdict).toBe('fail');
  });

  it('partial is what it says: two evaluations of one trace that disagree', () => {
    const m = deriveMoment(makeTrace(), [
      makeEval({ passed: true, rule_results: [{ ruleName: 'min_output_length', passed: true, score: 1, message: 'OK' }] }),
      makeEval({ passed: false, rule_results: [{ ruleName: 'sentence_count', passed: false, score: 0, message: 'Too few' }] }),
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

/*
 * D-0 (0.14.0): the server stops dropping the stamp.
 *
 * Until 0.14.0 deriveMomentDetail remapped every rule result to six fields
 * — name, passed, score, message, skipped, skipReason — and the stamp the
 * engine has put on each rule since 0.9.0 (kind, role, evidence,
 * uncertainty, criticality with its source) was dropped before the screen,
 * along with the evaluation's verdict, coverage, interpretations and
 * provenance. And a trace nobody had judged was labelled `normal-pass`.
 */
describe('deriveMomentDetail carries the stamp whole (D-0)', () => {
  const stamped = {
    ruleName: 'cost_under_threshold',
    passed: false,
    score: 0,
    message: 'over budget',
    kind: 'policy' as const,
    role: 'advisory' as const,
    question: 'within_budget' as const,
    critical: false,
    criticalSource: 'default' as const,
    evidence: [{ type: 'count' as const, stat: 'cost_usd', unit: 'usd', value: 1.33, threshold: 0.1, thresholdSource: 'default' as const }],
    uncertainty: { basis: 'measurement' },
  };
  const verdict = { state: 'pass' as const, passed: true, basis: 'clean' as const, by: [], risk: null };
  const coverage = { inputs: { output: true } as never, questions: [{ id: 'within_budget' as const, status: 'judged' as const, evaluated: 1, of: 1 }] };
  const interpretations = [{ severity: 'note' as const, addressee: 'operator' as const, rule: 'cost_under_threshold', text: 'advises at the default', configKey: 'eval.defaultsGate' }];
  const provenance = { irisVersion: '0.14.0', rulesetHash: 'r', configHash: 'c', thresholds: { default: 0.7 }, corpusVersion: 'x', composer: { defaultsGate: false, falsePassCost: 1, onCriticalSkipped: 'unknown' as const } };

  it('every field of a rule result and of the evaluation reaches the detail unchanged', () => {
    const evals = [makeEval({ rule_results: [stamped as never], verdict, coverage: coverage as never, interpretations, provenance: provenance as never, critical_skipped: ['no_pii'] })];
    const detail = deriveMomentDetail(makeTrace(), evals, []);
    expect(detail.evals[0].ruleResults[0]).toEqual(stamped);
    expect(detail.evals[0].verdict).toEqual(verdict);
    expect(detail.evals[0].coverage).toEqual(coverage);
    expect(detail.evals[0].interpretations).toEqual(interpretations);
    expect(detail.evals[0].provenance).toEqual(provenance);
    expect(detail.evals[0].criticalSkipped).toEqual(['no_pii']);
  });

  it('a trace nobody judged is `unevaluated`, never `normal-pass`', () => {
    const noEvals = deriveMoment(makeTrace(), []);
    expect(noEvals.verdict).toBe('unevaluated');
    expect(noEvals.significance.kind).toBe('unevaluated');
    expect(noEvals.significance.label).toBe('No verdict');
    const allSkipped = deriveMoment(makeTrace(), [makeEval({ rule_results: [{ ruleName: 'no_pii', passed: false, score: 0, message: 'no output', skipped: true, skipReason: 'no output' }] })]);
    expect(allSkipped.verdict).toBe('unevaluated');
    expect(allSkipped.significance.kind).toBe('unevaluated');
    expect(allSkipped.significance.reason).toMatch(/Unknown, not clean/);
  });

  it('the one kind list carries every kind the type admits, including the new one', () => {
    expect(MOMENT_SIGNIFICANCE_KINDS).toContain('unevaluated');
    expect(new Set(MOMENT_SIGNIFICANCE_KINDS).size).toBe(MOMENT_SIGNIFICANCE_KINDS.length);
  });
});
