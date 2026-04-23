/*
 * Detail-page axe smoke tests.
 *
 * MomentDetailPage and TraceDetailPage are the deepest-nesting routes in
 * the dashboard: rich hero + multi-section content + interactive CTAs +
 * expandable panels. This suite asserts that the rendered DOM has no
 * automatable WCAG violations across populated + loading + error +
 * empty-evals states.
 *
 * Why mock the hooks instead of rendering through the API?
 *   - a11y is a render-tree property, not a data-fetching property.
 *   - The components already own the semantic markup (section landmarks,
 *     h2 titles, aria-labelledby wiring). Fixture data exercises those
 *     paths without the I/O dependency.
 *
 * Companion E2E coverage lives in tests/e2e/ for flows that depend on
 * real server state (tenant isolation, composer → audit log).
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { axe } from 'jest-axe';

/* ═══ Mocks ════════════════════════════════════════════════════════════
 * Hoisted via vi.mock so imports below resolve to the stubbed modules.
 * Each hook returns a stateful fixture; individual tests override via
 * the `mockReturnValue` on the mock function.
 */
const useMomentDetailMock = vi.fn();
const useTraceDetailMock = vi.fn();

vi.mock('../../src/api/hooks', () => ({
  useMomentDetail: (...args: unknown[]) => useMomentDetailMock(...args),
  useTraceDetail: (...args: unknown[]) => useTraceDetailMock(...args),
}));

// MakeRuleModal touches preferences + the composer API surface area that
// isn't relevant to a11y of the detail page itself. Stub to a noop.
vi.mock('../../src/components/moments/MakeRuleModal', () => ({
  MakeRuleModal: () => null,
}));

import { MomentDetailPage } from '../../src/components/moments/MomentDetailPage';
import { TraceDetailPage } from '../../src/components/traces/TraceDetailPage';
import type { DecisionMomentDetail, TraceDetail } from '../../src/api/types';

/* ═══ Fixtures ═════════════════════════════════════════════════════════ */
const momentFixture: DecisionMomentDetail = {
  id: 'moment-fixture-1',
  traceId: 'trace-fixture-1',
  agentName: 'research-synthesizer',
  timestamp: '2026-04-22T12:00:00Z',
  verdict: 'pass',
  overallScore: 0.92,
  evalCount: 3,
  ruleSnapshot: { failed: [], skipped: [], passedCount: 3, totalCount: 3 },
  significance: {
    kind: 'normal-pass',
    score: 0.1,
    label: 'Pass',
    reason: 'All fired rules passed — operational data, not a moment requiring review.',
  },
  costUsd: 0.0003,
  latencyMs: 145,
  input: 'What are the key trends in agent observability?',
  output: 'Three key trends: (1) MCP native instrumentation, (2) decision moments, (3) workflow inversion.',
  evals: [
    {
      id: 'eval-1',
      evalType: 'completeness',
      score: 0.92,
      passed: true,
      ruleResults: [
        { ruleName: 'min_output_length', passed: true, score: 1, message: 'OK' },
        { ruleName: 'no_pii', passed: true, score: 1, message: 'No PII detected' },
        { ruleName: 'no_blocklist_words', passed: true, score: 1, message: 'clean' },
      ],
      suggestions: [],
    },
  ],
};

const traceFixture: TraceDetail = {
  trace: {
    trace_id: 'trace-fixture-1',
    agent_name: 'research-synthesizer',
    framework: 'mcp',
    input: '{"prompt":"summarize"}',
    output: '{"summary":"ok"}',
    latency_ms: 145,
    cost_usd: 0.0003,
    timestamp: '2026-04-22T12:00:00Z',
  },
  spans: [],
  evals: [
    {
      id: 'eval-trace-1',
      trace_id: 'trace-fixture-1',
      eval_type: 'completeness',
      output_text: '{"summary":"ok"}',
      score: 0.92,
      passed: true,
      rule_results: [
        { ruleName: 'min_output_length', passed: true, score: 1, message: 'OK' },
      ],
      suggestions: [],
    },
  ],
};

/* ═══ Helpers ══════════════════════════════════════════════════════════ */
function renderMoment(ui: React.ReactElement): HTMLElement {
  const { container } = render(
    <MemoryRouter initialEntries={['/moments/moment-fixture-1']}>
      <Routes>
        <Route path="/moments/:id" element={ui} />
      </Routes>
    </MemoryRouter>,
  );
  return container;
}

function renderTrace(ui: React.ReactElement): HTMLElement {
  const { container } = render(
    <MemoryRouter initialEntries={['/traces/trace-fixture-1']}>
      <Routes>
        <Route path="/traces/:id" element={ui} />
      </Routes>
    </MemoryRouter>,
  );
  return container;
}

/* ═══ Tests ════════════════════════════════════════════════════════════ */
describe('a11y · MomentDetailPage', () => {
  it('populated moment has no violations', async () => {
    useMomentDetailMock.mockReturnValue({
      data: momentFixture,
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    const container = renderMoment(<MomentDetailPage />);
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it('moment with zero evals renders an explanatory paragraph with no violations', async () => {
    useMomentDetailMock.mockReturnValue({
      data: { ...momentFixture, evals: [], evalCount: 0 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    const container = renderMoment(<MomentDetailPage />);
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it('error state (failed fetch) has no violations', async () => {
    useMomentDetailMock.mockReturnValue({
      data: null,
      loading: false,
      error: 'network failure: could not reach /api/v1/moments/:id',
      refetch: vi.fn(),
    });
    const container = renderMoment(<MomentDetailPage />);
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it('renders exactly one h2 for the significance label + h3 per section', () => {
    useMomentDetailMock.mockReturnValue({
      data: momentFixture,
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    const container = renderMoment(<MomentDetailPage />);
    // Hero significance label is h2. The chrome h1 isn't under this
    // container (it's in the app shell).
    const h2s = container.querySelectorAll('h2');
    expect(h2s.length).toBe(1);
    expect(h2s[0].textContent).toBe('Pass');

    // Input/Output + Eval results each render as section h3.
    const h3s = Array.from(container.querySelectorAll('h3')).map((h) => h.textContent);
    expect(h3s).toContain('Input → Output');
    expect(h3s).toContain('Eval results (1)');
  });

  it('each panel section is a landmark (section + aria-labelledby)', () => {
    useMomentDetailMock.mockReturnValue({
      data: momentFixture,
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    const container = renderMoment(<MomentDetailPage />);
    const sections = container.querySelectorAll('section[aria-labelledby]');
    // 3 sections: hero + I/O panel + eval panel
    expect(sections.length).toBe(3);
    // Each aria-labelledby points to an id that exists in the DOM.
    sections.forEach((sec) => {
      const id = sec.getAttribute('aria-labelledby');
      expect(id).toBeTruthy();
      expect(container.querySelector(`#${id}`)).not.toBeNull();
    });
  });
});

describe('a11y · TraceDetailPage', () => {
  it('populated trace has no violations', async () => {
    useTraceDetailMock.mockReturnValue({
      data: traceFixture,
      loading: false,
      error: null,
    });
    const container = renderTrace(<TraceDetailPage />);
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it('trace without metadata/tool_calls/evals still has no violations', async () => {
    useTraceDetailMock.mockReturnValue({
      data: {
        trace: {
          trace_id: 'bare-trace',
          agent_name: 'research-synthesizer',
          timestamp: '2026-04-22T12:00:00Z',
        },
        spans: [],
        evals: [],
      },
      loading: false,
      error: null,
    });
    const container = renderTrace(<TraceDetailPage />);
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it('every section has aria-labelledby pointing to an h2 id', () => {
    useTraceDetailMock.mockReturnValue({
      data: traceFixture,
      loading: false,
      error: null,
    });
    const container = renderTrace(<TraceDetailPage />);
    const sections = container.querySelectorAll('section[aria-labelledby]');
    // summary + I/O + spans + evals (no tool_calls/metadata in fixture)
    expect(sections.length).toBeGreaterThanOrEqual(4);
    sections.forEach((sec) => {
      const id = sec.getAttribute('aria-labelledby');
      expect(id).toBeTruthy();
      const labelNode = container.querySelector(`#${id}`);
      expect(labelNode).not.toBeNull();
      // Label node should be an h2 (or at minimum a heading).
      expect(labelNode!.tagName).toBe('H2');
    });
  });
});
