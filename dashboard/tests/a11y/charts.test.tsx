/*
 * Chart primitive axe smoke tests.
 *
 * Asserts that each chart primitive in the dashboard has no automatable
 * WCAG violations when rendered with representative data. This is a CI
 * gate that catches regressions in common a11y mistakes (missing
 * aria-label, missing role, low-contrast color against a test backdrop,
 * etc.).
 *
 * Not a substitute for manual screen-reader testing — axe only catches
 * the automatable subset. But "passes axe" is table stakes.
 *
 * Scope for v0.4.0 (audit item #4a):
 *   - Every chart primitive tested with populated data
 *   - Every chart primitive tested with EMPTY-state data (the skeleton
 *     shapes we ship must not violate a11y either)
 *   - Router-dependent components (BiggestMoversTable, PerRuleMeterGrid)
 *     wrapped in MemoryRouter for drill-through Link support
 *
 * NOT covered here (defer to Playwright E2E — audit item #5):
 *   - Full-route a11y audits (DashboardPage, MomentsTimelinePage, etc.)
 *   - Interactive flows (keyboard navigation through filters)
 *   - Live-region update behavior
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { axe } from 'jest-axe';
import { PassRateGauge } from '../../src/components/dashboard/charts/PassRateGauge';
import { Donut } from '../../src/components/dashboard/charts/Donut';
import { PassRateAreaChart } from '../../src/components/dashboard/charts/PassRateAreaChart';
import { HorizontalBarChart } from '../../src/components/dashboard/charts/HorizontalBarChart';
import { StackedBarByDay } from '../../src/components/dashboard/charts/StackedBarByDay';
import { BiggestMoversTable } from '../../src/components/dashboard/charts/BiggestMoversTable';
import type { DecisionMoment, EvalTrendPoint, AuditLogEntry } from '../../src/api/types';

/**
 * Assertion helper. Equivalent to jest-axe's toHaveNoViolations
 * matcher but matcher-free so it works with vitest. A failing test
 * produces a vitest diff listing every WCAG violation axe found —
 * which is exactly the signal we want when the gate fires.
 *
 * Every chart below asserts strict axe compliance — the nested-interactive
 * waivers from the #4a scaffolding have been retired. Per #4b, SVG
 * charts with per-datum interactivity (PassRateAreaChart audit markers,
 * StackedBarByDay per-day bars) now carry:
 *   - SVG <desc> with a plain-language data summary
 *   - A visually-hidden <ol> of <Link>s covering the same drill-through
 *     destinations the SVG bars/markers navigate to
 * Result: the SVG itself has no interactive descendants (aria-hidden
 * decorations only), and AT users reach every destination via the
 * hidden list.
 */
async function runAxe(container: HTMLElement, options?: Parameters<typeof axe>[1]) {
  return axe(container, options);
}

/** Minimal fixture factories so tests stay focused on a11y, not data. */
const sampleTrend: EvalTrendPoint[] = [
  { timestamp: '2026-04-16T00:00:00Z', passRate: 0.88, avgScore: 0.87, evalCount: 12 },
  { timestamp: '2026-04-17T00:00:00Z', passRate: 0.91, avgScore: 0.9, evalCount: 15 },
  { timestamp: '2026-04-18T00:00:00Z', passRate: 0.93, avgScore: 0.92, evalCount: 18 },
];

const sampleAudit: AuditLogEntry[] = [
  { ts: '2026-04-17T12:00:00Z', action: 'rule.deploy', user: 'local', ruleId: 'r1', ruleName: 'no-pii-strict' },
];

/*
 * Factory — returns a moment dated N days ago at noon UTC. Tests against
 * components with rolling windows (StackedBarByDay's 7-day bucketing)
 * must use relative dates; a hardcoded fixture date silently falls out
 * of the window as time passes and the component renders its empty state
 * — a time-flake we hit when CI ran 15 days after the fixture date.
 */
function makeSampleMoment(daysAgo: number = 1): DecisionMoment {
  const ts = new Date();
  ts.setUTCHours(12, 0, 0, 0);
  ts.setUTCDate(ts.getUTCDate() - daysAgo);
  return {
    id: `m-${daysAgo}`,
    traceId: `t-${daysAgo}`,
    agentName: 'agent-alpha',
    timestamp: ts.toISOString(),
    verdict: 'pass',
    overallScore: 0.9,
    evalCount: 3,
    ruleSnapshot: { failed: [], skipped: [], passedCount: 3, totalCount: 3 },
    significance: { kind: 'normal-pass', score: 0.1, label: 'Pass', reason: 'all rules passed' },
  };
}

function renderWithRouter(ui: React.ReactElement): HTMLElement {
  const { container } = render(<MemoryRouter>{ui}</MemoryRouter>);
  return container;
}

describe('a11y · chart primitives', () => {
  describe('PassRateGauge', () => {
    it('populated state has no violations', async () => {
      const { container } = render(
        <PassRateGauge value={0.91} delta={0.03} totalEvals={42} agentCount={5} periodLabel="30d" />,
      );
      const results = await runAxe(container);
      expect(results.violations).toEqual([]);
    });

    it('empty state (no evals) has no violations', async () => {
      const { container } = render(
        <PassRateGauge totalEvals={0} periodLabel="30d" />,
      );
      const results = await runAxe(container);
      expect(results.violations).toEqual([]);
    });
  });

  describe('Donut', () => {
    it('populated state has no violations', async () => {
      const container = renderWithRouter(
        <Donut
          title="Verdict mix"
          centerLabel="evals"
          slices={[
            { id: 'pass', label: 'Pass', value: 30, color: 'var(--eval-pass)', href: '/moments?verdict=pass' },
            { id: 'fail', label: 'Fail', value: 3, color: 'var(--eval-fail)', href: '/moments?verdict=fail' },
          ]}
        />,
      );
      const results = await runAxe(container);
      expect(results.violations).toEqual([]);
    });

    it('empty state has no violations', async () => {
      const container = renderWithRouter(
        <Donut
          title="Verdict mix"
          centerLabel="evals"
          slices={[
            { id: 'pass', label: 'Pass', value: 0, color: 'var(--eval-pass)' },
            { id: 'fail', label: 'Fail', value: 0, color: 'var(--eval-fail)' },
          ]}
          emptyMessage="No evals in this window."
        />,
      );
      const results = await runAxe(container);
      expect(results.violations).toEqual([]);
    });
  });

  describe('PassRateAreaChart', () => {
    it('populated state has no violations', async () => {
      const container = renderWithRouter(
        <PassRateAreaChart trend={sampleTrend} auditEntries={sampleAudit} periodLabel="7d" />,
      );
      const results = await runAxe(container);
      expect(results.violations).toEqual([]);
    });

    it('populated state exposes data summary in <desc>', () => {
      const container = renderWithRouter(
        <PassRateAreaChart trend={sampleTrend} auditEntries={sampleAudit} periodLabel="7d" />,
      );
      const desc = container.querySelector('desc');
      expect(desc).not.toBeNull();
      // Summary must include concrete values, not just a generic label.
      expect(desc!.textContent).toMatch(/\d+%.*\d+%/); // at least two percent values
      expect(desc!.textContent).toMatch(/evals/);
    });

    it('populated state exposes hidden drill-through list with audit links', () => {
      const container = renderWithRouter(
        <PassRateAreaChart trend={sampleTrend} auditEntries={sampleAudit} periodLabel="7d" />,
      );
      const hiddenList = container.querySelector('ol[aria-label="Audit events in view"]');
      expect(hiddenList).not.toBeNull();
      const links = hiddenList!.querySelectorAll('a[href*="/audit"]');
      expect(links.length).toBeGreaterThanOrEqual(1);
    });

    it('drill-through list uses the focus-within reveal class', () => {
      // The .iris-sr-reveal utility (globals.css) is clip-rect by default
      // and expands on :focus-within so sighted keyboard users see the
      // focus indicator when tabbing through the otherwise-hidden links.
      const container = renderWithRouter(
        <PassRateAreaChart trend={sampleTrend} auditEntries={sampleAudit} periodLabel="7d" />,
      );
      const hiddenList = container.querySelector('ol[aria-label="Audit events in view"]');
      expect(hiddenList).not.toBeNull();
      expect(hiddenList!.classList.contains('iris-sr-reveal')).toBe(true);
    });

    it('skeleton empty state has no violations', async () => {
      const container = renderWithRouter(
        <PassRateAreaChart trend={[]} auditEntries={[]} periodLabel="7d" />,
      );
      const results = await runAxe(container);
      expect(results.violations).toEqual([]);
    });
  });

  describe('HorizontalBarChart', () => {
    it('populated state has no violations', async () => {
      const container = renderWithRouter(
        <HorizontalBarChart
          title="Cost by agent"
          bars={[
            { id: 'a', label: 'agent-alpha', value: 1.23 },
            { id: 'b', label: 'agent-beta', value: 0.45 },
          ]}
        />,
      );
      const results = await runAxe(container);
      expect(results.violations).toEqual([]);
    });

    it('skeleton empty state has no violations', async () => {
      const container = renderWithRouter(
        <HorizontalBarChart title="Cost by agent" bars={[]} emptyMessage="No spend yet." />,
      );
      const results = await runAxe(container);
      expect(results.violations).toEqual([]);
    });
  });

  describe('StackedBarByDay', () => {
    it('populated state has no violations', async () => {
      const container = renderWithRouter(
        <StackedBarByDay moments={[makeSampleMoment(1), makeSampleMoment(2), makeSampleMoment(3)]} days={7} periodLabel="7d" />,
      );
      const results = await runAxe(container);
      expect(results.violations).toEqual([]);
    });

    it('populated state exposes data summary in <desc>', () => {
      const container = renderWithRouter(
        <StackedBarByDay moments={[makeSampleMoment(1), makeSampleMoment(2), makeSampleMoment(3)]} days={7} periodLabel="7d" />,
      );
      const desc = container.querySelector('desc');
      expect(desc).not.toBeNull();
      expect(desc!.textContent).toMatch(/Verdicts per day/);
      expect(desc!.textContent).toMatch(/pass|partial|fail/);
    });

    it('populated state exposes hidden drill-through list with day links', () => {
      const container = renderWithRouter(
        <StackedBarByDay moments={[makeSampleMoment(1), makeSampleMoment(2), makeSampleMoment(3)]} days={7} periodLabel="7d" />,
      );
      const hiddenList = container.querySelector('ol[aria-label="Per-day drill-through"]');
      expect(hiddenList).not.toBeNull();
      const links = hiddenList!.querySelectorAll('a[href*="/moments"]');
      expect(links.length).toBe(7); // one per day in the window
    });

    it('drill-through list uses the focus-within reveal class', () => {
      const container = renderWithRouter(
        <StackedBarByDay moments={[makeSampleMoment(1), makeSampleMoment(2), makeSampleMoment(3)]} days={7} periodLabel="7d" />,
      );
      const hiddenList = container.querySelector('ol[aria-label="Per-day drill-through"]');
      expect(hiddenList).not.toBeNull();
      expect(hiddenList!.classList.contains('iris-sr-reveal')).toBe(true);
    });

    it('empty state has no violations', async () => {
      const container = renderWithRouter(
        <StackedBarByDay moments={[]} days={7} periodLabel="7d" />,
      );
      const results = await runAxe(container);
      expect(results.violations).toEqual([]);
    });
  });

  describe('BiggestMoversTable', () => {
    it('empty state (skeleton rows) has no violations', async () => {
      const container = renderWithRouter(
        <BiggestMoversTable currentMoments={[]} priorMoments={[]} periodDays={7} periodLabel="7d" />,
      );
      const results = await runAxe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
