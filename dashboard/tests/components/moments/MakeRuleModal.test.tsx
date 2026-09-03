/*
 * MakeRuleModal — the composer must tell the truth about what it deploys.
 *
 *   - Severity: v0.5.0 turned high/critical from a sort key into a hard
 *     veto. The dropdown used to render bare `low/medium/high/critical`
 *     with no label, hint or tooltip (#375 item 3).
 *   - Cost pre-fill: a moment where cost_under_threshold failed used to
 *     pre-fill a rule NAMED cost cap whose check type was max_length with
 *     value 0.05 — "output must be at most 0.05 characters".
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { axe } from 'jest-axe';
import type { DecisionMomentDetail } from '../../../src/api/types';
import {
  MakeRuleModal,
  buildDefinition,
  suggestInitialState,
} from '../../../src/components/moments/MakeRuleModal';
import { SEVERITY_HARD_FAIL, SEVERITY_WEIGHT_ONLY, TT } from '../../../src/components/shared/tooltipText';

function moment(failed: string[]): DecisionMomentDetail {
  return {
    id: 'moment-1',
    traceId: 'trace-1',
    agentName: 'support-triage',
    timestamp: '2026-09-01T12:00:00Z',
    verdict: failed.length ? 'partial' : 'pass',
    overallScore: 0.6,
    evalCount: 1,
    ruleSnapshot: { failed, skipped: [], passedCount: 3, totalCount: 3 + failed.length },
    significance: { kind: 'normal-fail', score: 0.4, label: 'Partial', reason: 'fixture' },
    evals: [],
  };
}

function renderModal(m: DecisionMomentDetail) {
  return render(
    <MemoryRouter>
      <MakeRuleModal moment={m} onClose={vi.fn()} onDeployed={vi.fn()} />
    </MemoryRouter>,
  );
}

describe('MakeRuleModal — severity', () => {
  it('labels the field, describes each option, and explains the selected value', () => {
    renderModal(moment(['min_output_length']));
    const select = screen.getByLabelText(/Severity — what a failure does/) as HTMLSelectElement;
    expect(select.value).toBe('medium');

    const labels = Array.from(select.options).map((o) => o.text);
    expect(labels).toEqual([
      'low — score only',
      'medium — score only',
      'high — hard-fail (veto)',
      'critical — hard-fail (veto)',
    ]);

    // Hint is wired to the select via aria-describedby and states the
    // weight-only semantics for medium…
    const hint = document.getElementById(select.getAttribute('aria-describedby') as string);
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain(SEVERITY_WEIGHT_ONLY);
    expect(select.title).toBe(TT.ruleSeverityMedium);

    // …and flips to the hard-fail wording the moment critical is chosen.
    fireEvent.change(select, { target: { value: 'critical' } });
    expect(hint!.textContent).toContain(SEVERITY_HARD_FAIL);
    expect(hint!.textContent).toMatch(/Hard-fail/);
    expect(select.title).toBe(TT.ruleSeverityCritical);
  });

  it('a safety-derived moment pre-fills high and shows the hard-fail hint immediately', () => {
    renderModal(moment(['no_pii']));
    const select = screen.getByLabelText(/Severity/) as HTMLSelectElement;
    expect(select.value).toBe('high');
    const hint = document.getElementById(select.getAttribute('aria-describedby') as string);
    expect(hint!.textContent).toContain(SEVERITY_HARD_FAIL);
  });

  it('has no axe violations open', async () => {
    const { container } = renderModal(moment(['no_pii']));
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});

describe('MakeRuleModal — cost-spike pre-fill', () => {
  it('pre-fills a cost_threshold rule (max_cost 0.05), not max_length', () => {
    const state = suggestInitialState(moment(['cost_under_threshold']));
    expect(state).toMatchObject({
      name: 'my_cost_cap',
      evalType: 'cost',
      ruleType: 'cost_threshold',
      configValue: '0.05',
    });
    expect(buildDefinition(state)).toEqual({
      name: 'my_cost_cap',
      type: 'cost_threshold',
      config: { max_cost: 0.05 },
    });
  });

  it('renders the cost check type with its max_cost field', () => {
    renderModal(moment(['cost_under_threshold']));
    const type = screen.getByLabelText('Check type') as HTMLSelectElement;
    expect(type.value).toBe('cost_threshold');
    const config = screen.getByLabelText('max_cost') as HTMLInputElement;
    expect(config.value).toBe('0.05');
    expect(screen.getByText(/USD ceiling per trace/)).toBeInTheDocument();
  });

  it('accepts a zero ceiling and rejects a negative or empty one', () => {
    const base = suggestInitialState(moment(['cost_under_threshold']));
    expect(buildDefinition({ ...base, configValue: '0' })?.config).toEqual({ max_cost: 0 });
    expect(buildDefinition({ ...base, configValue: '-1' })).toBeNull();
    expect(buildDefinition({ ...base, configValue: '' })).toBeNull();
    expect(buildDefinition({ ...base, configValue: 'abc' })).toBeNull();
  });
});
