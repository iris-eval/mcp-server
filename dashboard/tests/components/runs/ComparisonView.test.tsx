/*
 * The comparison view renders the tool's answer: the verdict word, the
 * method, the two runs with their intervals, the difference, the per-rule
 * movement, and the reasons when the runs are not comparable.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { axe } from 'jest-axe';
import { ComparisonView } from '../../../src/components/runs/ComparisonView';
import type { CompareRunsResult } from '../../../src/api/types';

const summary = (run_id: string, passed: number, n: number): CompareRunsResult['before'] => ({
  run_id,
  n,
  passed,
  rate: n ? passed / n : null,
  interval: n ? { lo: Math.max(0, passed / n - 0.3), hi: Math.min(1, passed / n + 0.2) } : null,
  agent_names: ['support-bot'],
  engine_versions: ['0.13.0'],
  ruleset_hashes: ['3f2a91c0'],
  config_hashes: ['9b1c'],
  superseded: 0,
});

const worse: CompareRunsResult = {
  comparable: true,
  incomparable_because: [],
  forced: false,
  method: 'paired-mcnemar',
  before: summary('baseline', 38, 40),
  after: summary('candidate', 30, 40),
  difference: { delta: -0.2, lo: -0.25, hi: -0.053, significant: true },
  paired: { method: 'mcnemar-exact', b: 9, c: 1, concordant: 30, pairs: 40, p_value: 0.021, significant: true, fell: { share: 0.9, lo: 0.606, hi: 0.995 } },
  worse: true,
  better: false,
  improvement_withheld: false,
  call: 'worse',
  smallest_detectable: 0.12,
  equivalent_within: { margin: 0.12, margin_source: 'caller', interval: { lo: -0.31, hi: -0.09 }, holds: false },
  coverage: { lost: [], gained: [] },
  critical_rises: [],
  rules_tested: 2,
  regressions: [
    {
      rule: 'no_stub_output',
      failed_before: 1,
      failed_after: 8,
      delta: 7,
      judged_before: 40,
      judged_after: 40,
      difference: { delta: -0.175, lo: -0.31, hi: -0.04, significant: true },
      test: 'mcnemar-exact',
      p: 0.0039,
      q: 0.0078,
      worse: true,
    },
  ],
  improvements: [
    {
      rule: 'min_output_length',
      failed_before: 2,
      failed_after: 1,
      delta: -1,
      judged_before: 40,
      judged_after: 40,
      difference: { delta: 0.025, lo: -0.08, hi: 0.13, significant: false },
      test: 'mcnemar-exact',
      p: 0.75,
      q: 0.75,
      worse: false,
    },
  ],
  summary: 'candidate is worse than baseline: 8 more failures on 40 paired cases.',
};

function view(result: CompareRunsResult) {
  return render(
    <MemoryRouter>
      <ComparisonView result={result} />
    </MemoryRouter>,
  );
}

describe('ComparisonView', () => {
  it('a worse candidate: the word, the method, the difference, the p, the smallest detectable, the runs, the rules', () => {
    const { container } = view(worse);
    expect(container.querySelector('[data-comparison-verdict]')?.textContent).toBe('WORSE');
    expect(container.querySelector('[data-method]')?.textContent).toBe('paired-mcnemar');
    // Paired: the point alone, and beside it the interval the test read, on which way the changed cases went.
    expect(container.querySelector('[data-difference]')?.textContent).toBe('-20.0 pts');
    expect(container.querySelector('[data-paired-p]')?.textContent).toBe('9 of 10 changed cases fell [60.6%, 99.5%]');
    expect(container.querySelector('[data-paired-p]')?.getAttribute('data-paired-fell')).toBe('0.900');
    expect(container.querySelector('[data-smallest-detectable]')?.textContent).toBe('detects ≥ 12.0 pts');
    expect(container.querySelector('[data-compare-run="before"]')?.textContent).toContain('38 of 40 passed');
    expect(container.querySelector('[data-compare-run="after"]')?.textContent).toContain('30 of 40 passed');
    expect(container.querySelector('[data-summary]')?.textContent).toContain('8 more failures');
    expect(container.textContent).toContain('no_stub_output');
    expect(container.textContent).toContain('+7');
    // A rule's failures are of the cases it ran on.
    expect(container.querySelector('[data-rule-judged-after="40"]')?.textContent).toBe('8 of 40');
    expect(container.querySelector('[data-coverage-lost]')).toBeNull();
    expect(container.querySelector('[data-critical-rises]')).toBeNull();
    expect(container.querySelector('[data-incomparable-because]')).toBeNull();
    expect(container.querySelector('[data-forced]')).toBeNull();
  });

  it('runs that are not comparable: NOT COMPARED, the reasons listed, no difference', () => {
    const { container } = view({
      ...worse,
      comparable: false,
      incomparable_because: ['different rulesets: 3f2a91c0 vs 77aa0e11', 'different agents'],
      method: 'none',
      difference: null,
      paired: null,
      worse: false,
      better: false,
      smallest_detectable: null,
      regressions: [],
      improvements: [],
      summary: 'Not compared.',
    });
    expect(container.querySelector('[data-comparison-verdict]')?.textContent).toBe('NOT COMPARED');
    expect(container.querySelectorAll('[data-incomparable-because]')).toHaveLength(2);
    expect(container.querySelector('[data-difference]')).toBeNull();
  });

  it('a forced comparison says so beside the numbers', () => {
    const { container } = view({ ...worse, comparable: false, forced: true, incomparable_because: ['different agents'] });
    expect(container.querySelector('[data-forced]')).not.toBeNull();
    expect(container.querySelector('[data-comparison-verdict]')?.textContent).toBe('WORSE');
  });

  it('every rule row carries its one-sided p and its corrected q, and only a surviving rule is marked worse', () => {
    const { container } = view(worse);
    const stub = container.querySelector('[data-rule-row="no_stub_output"]');
    expect(stub?.getAttribute('data-rule-worse')).toBe('true');
    expect(stub?.textContent).toContain('worse');
    const length = container.querySelector('[data-rule-row="min_output_length"]');
    expect(length?.getAttribute('data-rule-worse')).toBe('false');
    expect(length?.textContent).not.toContain('worse');
    const ps = [...container.querySelectorAll('[data-rule-p]')].map((el) => el.textContent);
    expect(ps).toEqual(['p = 0.004', 'p = 0.750']);
    const qs = [...container.querySelectorAll('[data-rule-q]')].map((el) => el.textContent);
    expect(qs).toEqual(['q = 0.008', 'q = 0.750']);
    expect(container.querySelector('[data-rules-tested]')?.textContent).toBe('2 tested · corrected together');
  });

  it('the equivalence finding is its own chip — not equivalent here, equivalent when the 90% interval sits inside the margin', () => {
    const { container: a } = view(worse);
    expect(a.querySelector('[data-equivalent-within]')?.getAttribute('data-equivalent-within')).toBe('false');
    expect(a.querySelector('[data-equivalent-within]')?.textContent).toBe('interval reaches outside ±12.0 pts');
    const { container: b } = view({
      ...worse,
      worse: false,
      difference: { delta: 0.01, lo: -0.05, hi: 0.07, significant: false },
      paired: null,
      method: 'unpaired-newcombe',
      call: 'equivalent',
      equivalent_within: { margin: 0.1, margin_source: 'caller', interval: { lo: -0.04, hi: 0.06 }, holds: true },
    });
    expect(b.querySelector('[data-comparison-verdict]')?.textContent).toBe('EQUIVALENT');
    expect(b.querySelector('[data-equivalent-within]')?.getAttribute('data-equivalent-within')).toBe('true');
    expect(b.querySelector('[data-equivalent-within]')?.textContent).toBe('interval inside ±10.0 pts');
    // Unpaired, the difference carries its own interval.
    expect(b.querySelector('[data-difference]')?.textContent).toBe('+1.0 pts [-5.0, 7.0]');
    const { container: c } = view({ ...worse, equivalent_within: null });
    expect(c.querySelector('[data-equivalent-within]')).toBeNull();
  });

  it('a run judged on less is not called better: the word, the rules that stopped running, and the cases they stopped on', () => {
    const { container } = view({
      ...worse,
      worse: false,
      better: false,
      improvement_withheld: true,
      call: 'undetermined',
      difference: { delta: 0.58, lo: 0.2, hi: 0.58, significant: true },
      paired: { method: 'mcnemar-exact', b: 0, c: 7, concordant: 5, pairs: 12, p_value: 0.016, significant: true, fell: { share: 0, lo: 0, hi: 0.348 } },
      smallest_detectable: null,
      equivalent_within: null,
      coverage: {
        lost: [
          { rule: 'no_silent_tool_failure', judged_before: 12, of_before: 12, judged_after: 0, of_after: 12, on_shared: 12 },
          { rule: 'no_tool_loop', judged_before: 12, of_before: 12, judged_after: 0, of_after: 12, on_shared: 12 },
        ],
        gained: [],
      },
      regressions: [],
      improvements: [
        { rule: 'no_silent_tool_failure', failed_before: 7, failed_after: 0, delta: -7, judged_before: 12, judged_after: 0, difference: null, test: null, p: null, q: null, worse: false },
      ],
      discordant_total: 1,
      discordant: [
        {
          case_key: 'case-00',
          before: { eval_id: 'e1', trace_id: 't1', passed: false },
          after: { eval_id: 'e2', trace_id: 't2', passed: true },
          direction: 'recovered',
          rules: [{ rule: 'no_silent_tool_failure', before: false, after: true }],
          not_judged_after: ['no_silent_tool_failure', 'no_tool_loop'],
        },
      ],
    });
    expect(container.querySelector('[data-comparison-verdict]')?.textContent).toBe('JUDGED ON LESS');
    expect(container.querySelector('[data-coverage-lost]')?.getAttribute('data-coverage-lost')).toBe('2');
    expect(container.querySelector('[data-coverage-lost-rule="no_silent_tool_failure"]')?.textContent).toBe('no_silent_tool_failure: ran on 12 of 12 cases before, 0 of 12 after');
    // The rule that stopped running reads "not run", never "0 failed".
    expect(container.querySelector('[data-rule-judged-after="0"]')?.textContent).toBe('not run');
    expect(container.querySelector('[data-rule-p]')?.textContent).toBe('—');
    expect(container.querySelector('[data-not-judged-after]')?.textContent).toContain('not run after: no_silent_tool_failure, no_tool_loop');
  });

  it('a critical rule firing on new cases is listed with the cases, whatever the verdict word is', () => {
    const { container } = view({
      ...worse,
      worse: false,
      call: 'undetermined',
      critical_rises: [{ rule: 'no_pii', before: 1, after: 5, new_on: ['case-01', 'case-02', 'case-03', 'case-04'] }],
    });
    expect(container.querySelector('[data-critical-rises]')?.getAttribute('data-critical-rises')).toBe('1');
    const row = container.querySelector('[data-critical-rise-rule="no_pii"]');
    expect(row?.textContent).toContain('fires on 5 cases after, 1 before');
    expect(row?.querySelectorAll('a')).toHaveLength(4);
    expect(row?.querySelector('a')?.getAttribute('href')).toBe('/cases/case-01');
  });

  it('has no axe violations', async () => {
    const { container } = view(worse);
    expect((await axe(container)).violations).toEqual([]);
    const { container: less } = view({
      ...worse,
      coverage: { lost: [{ rule: 'no_tool_loop', judged_before: 12, of_before: 12, judged_after: 0, of_after: 12, on_shared: 12 }], gained: [] },
      critical_rises: [{ rule: 'no_pii', before: 0, after: 1, new_on: ['case-01'] }],
    });
    expect((await axe(less)).violations).toEqual([]);
  });
});

describe('the discordant cases', () => {
  it('renders each flipped case, regressions first, with the rules that flipped and a link to the moment', () => {
    const result: CompareRunsResult = {
      ...worse,
      discordant_total: 2,
      discordant: [
        { case_key: 'case-5', before: { eval_id: 'e1', trace_id: 't-before-5', passed: false }, after: { eval_id: 'e2', trace_id: 't-after-5', passed: true }, direction: 'recovered', rules: [{ rule: 'no_pii', before: false, after: true }] },
        { case_key: 'case-1', before: { eval_id: 'e3', trace_id: 't-before-1', passed: true }, after: { eval_id: 'e4', trace_id: 't-after-1', passed: false }, direction: 'regressed', rules: [{ rule: 'min_output_length', before: true, after: false }] },
      ],
    };
    const { container } = render(
      <MemoryRouter>
        <ComparisonView result={result} />
      </MemoryRouter>,
    );
    const rows = container.querySelectorAll('[data-discordant-row]');
    expect(rows).toHaveLength(2);
    expect(container.querySelector('[data-discordant-count]')?.getAttribute('data-discordant-count')).toBe('2');
    expect(container.querySelector('[data-discordant-row="case-1"]')?.textContent).toContain('min_output_length');
    expect(container.querySelector('[data-discordant-open="case-1"]')?.getAttribute('href')).toBe('/traces/t-after-1');
  });

  it('renders nothing for an answer without the list (an older server)', () => {
    const { container } = render(
      <MemoryRouter>
        <ComparisonView result={worse} />
      </MemoryRouter>,
    );
    expect(container.querySelector('[data-discordant-count]')).toBeNull();
  });
});
