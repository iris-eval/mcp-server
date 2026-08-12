/*
 * searchCorpus — the pure matcher behind the ⌘K data search. Tested
 * directly (no fetch machinery) so the ranking rules are pinned:
 * startsWith beats includes, name/agent fields beat body fields, each
 * section caps at MAX_MATCHES_PER_KIND.
 */
import { describe, it, expect } from 'vitest';
import {
  searchCorpus,
  MIN_QUERY_LENGTH,
  MAX_MATCHES_PER_KIND,
  type DataCorpus,
} from '../../../src/components/command/useCommandSearch';
import type { DeployedCustomRule, EvalResult, Trace } from '../../../src/api/types';

function makeRule(id: string, name: string, overrides: Partial<DeployedCustomRule> = {}): DeployedCustomRule {
  return {
    id,
    name,
    description: '',
    evalType: 'safety',
    severity: 'high',
    definition: { name, type: 'regex_no_match', config: {} },
    enabled: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

function makeTrace(id: string, agent: string, overrides: Partial<Trace> = {}): Trace {
  return {
    trace_id: id,
    agent_name: agent,
    timestamp: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeEval(id: string, overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    id,
    eval_type: 'safety',
    output_text: 'ok',
    score: 1,
    passed: true,
    rule_results: [],
    suggestions: [],
    ...overrides,
  };
}

const emptyCorpus: DataCorpus = { rules: [], traces: [], evals: [] };

describe('searchCorpus', () => {
  it('returns nothing under the minimum query length', () => {
    const corpus: DataCorpus = { ...emptyCorpus, rules: [makeRule('r1', 'a_rule')] };
    expect(searchCorpus(corpus, '')).toEqual([]);
    expect(searchCorpus(corpus, 'a'.repeat(MIN_QUERY_LENGTH - 1))).toEqual([]);
  });

  it('matches rules by name, traces by agent, evals by type — case-insensitively', () => {
    const corpus: DataCorpus = {
      rules: [makeRule('r1', 'No_PII_Leak')],
      traces: [makeTrace('t1', 'Checkout-Agent')],
      evals: [makeEval('e1', { eval_type: 'completeness' })],
    };

    expect(searchCorpus(corpus, 'no_pii')).toEqual([
      expect.objectContaining({ kind: 'rule', title: 'No_PII_Leak', to: '/rules' }),
    ]);
    expect(searchCorpus(corpus, 'checkout')).toEqual([
      expect.objectContaining({ kind: 'trace', title: 'Checkout-Agent', to: '/traces/t1' }),
    ]);
    expect(searchCorpus(corpus, 'complete')).toEqual([
      expect.objectContaining({ kind: 'eval', title: 'completeness — PASS' }),
    ]);
  });

  it('matches traces and evals by output text', () => {
    const corpus: DataCorpus = {
      ...emptyCorpus,
      traces: [makeTrace('t1', 'agent-a', { output: 'The SSN is 123-45-6789' })],
      evals: [makeEval('e1', { output_text: 'leaked an SSN', passed: false, trace_id: 't1' })],
    };
    const matches = searchCorpus(corpus, 'ssn');
    expect(matches.map((m) => m.kind)).toEqual(['trace', 'eval']);
    expect(matches[1]).toEqual(
      expect.objectContaining({ title: 'safety — FAIL', to: '/traces/t1' }),
    );
  });

  it('an eval without a trace link lands on the evals list', () => {
    const corpus: DataCorpus = {
      ...emptyCorpus,
      evals: [makeEval('e1', { trace_id: undefined, eval_type: 'relevance' })],
    };
    expect(searchCorpus(corpus, 'relevance')[0]).toEqual(
      expect.objectContaining({ to: '/evals' }),
    );
  });

  it('ranks startsWith above substring matches', () => {
    const corpus: DataCorpus = {
      ...emptyCorpus,
      rules: [makeRule('r1', 'has_cost_check'), makeRule('r2', 'cost_threshold')],
    };
    const matches = searchCorpus(corpus, 'cost');
    expect(matches.map((m) => m.title)).toEqual(['cost_threshold', 'has_cost_check']);
  });

  it('caps each section at MAX_MATCHES_PER_KIND', () => {
    const corpus: DataCorpus = {
      ...emptyCorpus,
      traces: Array.from({ length: MAX_MATCHES_PER_KIND + 3 }, (_, i) =>
        makeTrace(`t${i}`, `agent-${i}`),
      ),
    };
    expect(searchCorpus(corpus, 'agent-')).toHaveLength(MAX_MATCHES_PER_KIND);
  });

  it('returns nothing when nothing matches', () => {
    const corpus: DataCorpus = {
      rules: [makeRule('r1', 'no_pii')],
      traces: [makeTrace('t1', 'agent-a')],
      evals: [makeEval('e1')],
    };
    expect(searchCorpus(corpus, 'zzzz')).toEqual([]);
  });
});
