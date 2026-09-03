/*
 * Safety classification on the charts comes from the rule's CATEGORY,
 * never from name substrings. The old `includes('pii') || includes(
 * 'injection') || …` test did not know no_hallucination_markers had
 * joined the safety bundle, so its failures drilled to normal-fail on two
 * charts for a whole release.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import {
  BUILT_IN_RULE_CATEGORY,
  ruleToSignificanceKind,
} from '../../../src/components/dashboard/ruleCategories';
import { TopFailingRulesBars } from '../../../src/components/dashboard/charts/TopFailingRulesBars';
import { PerRuleMeterGrid } from '../../../src/components/dashboard/charts/PerRuleMeterGrid';
import type { DecisionMoment } from '../../../src/api/types';

function momentFailing(failed: string[]): DecisionMoment {
  return {
    id: `m-${failed.join('-')}`,
    traceId: 't',
    agentName: 'report-writer',
    timestamp: '2026-09-01T12:00:00Z',
    verdict: 'partial',
    overallScore: 0.5,
    evalCount: 1,
    ruleSnapshot: { failed, skipped: [], passedCount: 2, totalCount: 2 + failed.length },
    significance: { kind: 'safety-violation', score: 1, label: 'Safety', reason: 'fixture' },
  };
}

function hrefs(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');
}

describe('ruleToSignificanceKind', () => {
  it('classifies every safety-bundle rule as a safety violation, hallucination markers included', () => {
    for (const rule of ['no_pii', 'no_injection_patterns', 'no_blocklist_words', 'no_stub_output', 'no_hallucination_markers']) {
      expect(ruleToSignificanceKind(rule, BUILT_IN_RULE_CATEGORY)).toBe('safety-violation');
    }
  });

  it('maps cost rules to cost-spike and everything else to normal-fail', () => {
    expect(ruleToSignificanceKind('cost_under_threshold', BUILT_IN_RULE_CATEGORY)).toBe('cost-spike');
    expect(ruleToSignificanceKind('min_output_length', BUILT_IN_RULE_CATEGORY)).toBe('normal-fail');
    expect(ruleToSignificanceKind('my_custom_rule', BUILT_IN_RULE_CATEGORY)).toBe('normal-fail');
  });

  it('follows a server-supplied map over the vendored one', () => {
    const server = { ...BUILT_IN_RULE_CATEGORY, brand_new_safety_rule: 'safety' as const };
    expect(ruleToSignificanceKind('brand_new_safety_rule', server)).toBe('safety-violation');
  });
});

describe('charts drill hallucination failures to the safety filter', () => {
  it('TopFailingRulesBars', () => {
    const { container } = render(
      <MemoryRouter>
        <TopFailingRulesBars
          moments={[momentFailing(['no_hallucination_markers'])]}
          periodStartIso="2026-08-25T00:00:00.000Z"
          periodLabel="7d"
        />
      </MemoryRouter>,
    );
    const links = hrefs(container).filter((h) => h.includes('/moments'));
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((h) => h.includes('kind=safety-violation'))).toBe(true);
  });

  it('PerRuleMeterGrid', () => {
    const { container } = render(
      <MemoryRouter>
        <PerRuleMeterGrid
          currentMoments={[momentFailing(['no_hallucination_markers'])]}
          priorMoments={[]}
          periodStartIso="2026-08-25T00:00:00.000Z"
          periodLabel="7d"
        />
      </MemoryRouter>,
    );
    const row = Array.from(container.querySelectorAll('a')).find((a) =>
      a.textContent?.includes('no_hallucination_markers'),
    );
    expect(row).toBeDefined();
    expect(row!.getAttribute('href')).toContain('kind=safety-violation');
  });
});
