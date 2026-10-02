/*
 * A rule that did not run is not drawn as a pass.
 *
 * The grid took "not in the failed list" for a pass, so `expected_coverage`,
 * which skipped on all 84 evaluations of a run with no expected output, was
 * drawn as a full green bar titled "84 firings, 100% pass", and the header
 * counted 84 × 25 "rule firings". A rule's rate is now over the moments it
 * ran on, and one that ran on none reads "not run".
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { PerRuleMeterGrid, ruleOutcome, tallyRule } from '../../../src/components/dashboard/charts/PerRuleMeterGrid';
import type { DecisionMoment } from '../../../src/api/types';

function moment(i: number, snapshot: { failed?: string[]; passed?: string[]; skipped?: string[] }): DecisionMoment {
  const failed = snapshot.failed ?? [];
  const passed = snapshot.passed ?? [];
  const skipped = snapshot.skipped ?? [];
  return {
    id: `m-${i}`,
    traceId: `t-${i}`,
    agentName: 'support-bot',
    timestamp: new Date(Date.UTC(2026, 8, 1, 12, i)).toISOString(),
    verdict: failed.length > 0 ? 'fail' : 'pass',
    overallScore: 0.9,
    evalCount: 1,
    ruleSnapshot: { failed, passed, skipped, passedCount: passed.length, totalCount: failed.length + passed.length + skipped.length },
    significance: { kind: 'normal-pass', score: 0.1, label: 'Pass', reason: 'fixture' },
  };
}

// Three evaluated traces. no_pii ran on all three and fired once; expected_coverage skipped on all three; no_tool_loop was not in the evaluation at all.
const moments = [
  moment(0, { passed: ['no_pii', 'non_empty_output'], skipped: ['expected_coverage'] }),
  moment(1, { failed: ['no_pii'], passed: ['non_empty_output'], skipped: ['expected_coverage'] }),
  moment(2, { passed: ['no_pii', 'non_empty_output'], skipped: ['expected_coverage'] }),
];

function grid(current: DecisionMoment[]) {
  return render(
    <MemoryRouter>
      <PerRuleMeterGrid currentMoments={current} priorMoments={[]} periodStartIso="2026-09-01T00:00:00Z" periodLabel="24h" />
    </MemoryRouter>,
  );
}

describe('PerRuleMeterGrid', () => {
  it('a rule is failed, passed or not run on a moment, and only the first two are counted', () => {
    expect(ruleOutcome(moments[1], 'no_pii')).toBe('failed');
    expect(ruleOutcome(moments[0], 'no_pii')).toBe('passed');
    expect(ruleOutcome(moments[0], 'expected_coverage')).toBeNull();
    expect(ruleOutcome(moments[0], 'no_tool_loop')).toBeNull();
    expect(tallyRule(moments, 'no_pii')).toEqual({ pass: 2, total: 3, notRun: 0 });
    expect(tallyRule(moments, 'expected_coverage')).toEqual({ pass: 0, total: 0, notRun: 3 });
    // A moment from a server that sends no passed list counts nothing as a pass.
    const old = { ...moments[0], ruleSnapshot: { ...moments[0].ruleSnapshot, passed: undefined as unknown as string[] } };
    expect(tallyRule([old], 'no_pii')).toEqual({ pass: 0, total: 0, notRun: 1 });
  });

  it('a rule that skipped on every evaluation reads "not run", with an empty bar', () => {
    const { container } = grid(moments);
    const skipped = container.querySelector('[data-rule-meter="expected_coverage"]')!;
    expect(skipped.getAttribute('data-rule-ran')).toBe('0');
    expect(skipped.getAttribute('data-rule-not-run')).toBe('3');
    expect(skipped.getAttribute('title')).toBe('expected_coverage: not run on any of 3 evaluated traces');
    expect(skipped.textContent).toContain('not run (3)');
    expect(skipped.textContent).not.toContain('100%');
    // A rule that was not in the evaluation at all reads the same way.
    expect(container.querySelector('[data-rule-meter="no_tool_loop"]')?.textContent).toContain('not run (3)');
  });

  it('a rule that ran reads its rate over the traces it ran on', () => {
    const { container } = grid(moments);
    const pii = container.querySelector('[data-rule-meter="no_pii"]')!;
    expect(pii.getAttribute('title')).toBe('no_pii: ran on 3 of 3 evaluated traces, 67% passed');
    expect(pii.textContent).toContain('67%');
    expect(container.querySelector('[data-rule-meter="non_empty_output"]')?.getAttribute('title')).toBe('non_empty_output: ran on 3 of 3 evaluated traces, 100% passed');
  });

  it('the header counts the checks that ran, and says how many did not', () => {
    const { container } = grid(moments);
    const header = container.querySelector('[data-rule-checks-run]')!;
    // no_pii and non_empty_output ran three times each.
    expect(header.getAttribute('data-rule-checks-run')).toBe('6');
    expect(Number(header.getAttribute('data-rule-checks-not-run'))).toBeGreaterThan(60);
    expect(header.textContent).toContain('6 rule checks run');
    expect(header.textContent).toContain('not run');
    expect(header.textContent).not.toContain('firings');
  });

  it('with no moments, it says there is no rule activity', () => {
    const { container } = grid([]);
    expect(container.textContent).toContain('No rule activity in 24h');
  });
});
