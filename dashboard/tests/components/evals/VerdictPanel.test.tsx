/*
 * The verdict panel: basis, by, risk, coverage with counts, the
 * composer's sentences, and the ladder control. The fixture is the plan's
 * own case — a $1.33 trace at defaults: cost_under_threshold fails against
 * the shipped $0.10, does not decide, and the verdict passes and says why.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { VerdictPanel, type VerdictPanelProps } from '../../../src/components/evals/VerdictPanel';
import { NO_VERDICT_TEXT } from '../../../src/components/evals/verdictText';
import type { Coverage, EvalRuleResult, Interpretation, Provenance, Verdict } from '../../../src/api/types';

const rules: EvalRuleResult[] = [
  {
    ruleName: 'cost_under_threshold',
    passed: false,
    score: 0,
    message: 'cost $1.33 exceeds threshold $0.10',
    kind: 'policy',
    role: 'advisory',
    origin: 'built-in',
    question: 'within_budget',
    evidence: [{ type: 'count', stat: 'cost', unit: 'usd', value: 1.33, threshold: 0.1, thresholdSource: 'default' }],
    uncertainty: { basis: 'policy' },
  },
  { ruleName: 'min_output_length', passed: true, score: 1, message: 'OK', kind: 'measurement', role: 'advisory', question: 'complete' },
  { ruleName: 'no_pii', passed: false, score: 0, message: 'skipped', skipped: true, skipReason: 'no output', kind: 'detection' },
];

const verdict: Verdict = { state: 'pass', passed: true, basis: 'clean', by: [], risk: null };

const coverage: Coverage = {
  inputs: { output: true, cost_usd: true },
  questions: [
    { id: 'within_budget', status: 'judged', evaluated: 1, of: 1 },
    { id: 'complete', status: 'judged', evaluated: 1, of: 3 },
    { id: 'safe_output', status: 'unjudged', why: 'not supplied: output', evaluated: 0, of: 3 },
  ],
};

const interpretations: Interpretation[] = [
  {
    severity: 'warn',
    addressee: 'operator',
    rule: 'cost_under_threshold',
    text: 'cost_under_threshold failed against a threshold Iris ships, not one you set, so it did not decide this verdict. Set it in your configuration to make it a gate, or set eval.defaultsGate.',
    configKey: 'eval.defaultsGate',
  },
];

const provenance: Provenance = {
  irisVersion: '0.13.0',
  rulesetHash: 'abcdef0123456789',
  configHash: '0123456789abcdef',
  thresholds: { default: 0.7 },
  corpusVersion: 'a4e0e6d77d07',
  composer: { defaultsGate: false, falsePassCost: 1, onCriticalSkipped: 'unknown' },
};

function panel(over: Partial<VerdictPanelProps> = {}) {
  const props: VerdictPanelProps = {
    evalType: 'cost',
    passed: true,
    score: 0.5,
    verdict,
    coverage,
    interpretations,
    provenance,
    ruleResults: rules,
    expanded: false,
    onToggleExpanded: vi.fn(),
    ...over,
  };
  return { ...render(<VerdictPanel {...props} />), props };
}

describe('VerdictPanel: the verdict with its basis, coverage and reasons', () => {
  it('a $1.33 trace at defaults: PASS on basis clean, and the sentence names cost_under_threshold and eval.defaultsGate', () => {
    const { container } = panel();
    expect(container.querySelector('[data-verdict-state]')?.textContent).toBe('PASS');
    expect(container.querySelector('[data-basis]')?.getAttribute('data-basis')).toBe('clean');
    const note = container.querySelector('[data-interpretation-rule="cost_under_threshold"]');
    expect(note).not.toBeNull();
    expect(note?.getAttribute('data-config-key')).toBe('eval.defaultsGate');
    expect(note?.textContent).toContain('did not decide this verdict');
    expect(note?.querySelector('[data-severity="warn"]')).not.toBeNull();
    expect(note?.querySelector('[data-addressee="operator"]')).not.toBeNull();
  });

  it('coverage lists each question with its status, its counts and its reason', () => {
    const { container } = panel();
    const budget = container.querySelector('[data-question="within_budget"]');
    expect(budget?.getAttribute('data-question-status')).toBe('judged');
    expect(budget?.querySelector('[data-evaluated]')?.textContent).toBe('1 of 1 rules ran');
    const safe = container.querySelector('[data-question="safe_output"]');
    expect(safe?.getAttribute('data-question-status')).toBe('unjudged');
    expect(safe?.textContent).toContain('not supplied: output');
    expect(safe?.textContent).toContain('Safe to show');
  });

  it("the question's full text comes from the server when the page has it", async () => {
    const { container } = panel({ questionText: new Map([['within_budget', 'Did the run cost what the deployment allows?']]) });
    const label = container.querySelector('[data-question="within_budget"] span[tabindex="0"]') as HTMLElement;
    await userEvent.hover(label);
    expect(await screen.findByText('Did the run cost what the deployment allows?', {}, { timeout: 2500 })).toBeTruthy();
  });

  it('the counts: passed, failed, skipped', () => {
    const { container } = panel();
    expect(container.textContent).toContain('1p · 1f · 1s');
  });

  it('the ladder control reports its state and calls back; the composer facts show only when open', () => {
    const { container, props } = panel();
    const btn = container.querySelector('[data-ladder-toggle]') as HTMLButtonElement;
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.textContent).toBe('How was this computed?');
    expect(container.querySelector('[data-composer-facts]')).toBeNull();
    fireEvent.click(btn);
    expect(props.onToggleExpanded).toHaveBeenCalledTimes(1);
    const { container: open } = panel({ expanded: true });
    const facts = open.querySelector('[data-composer-facts]');
    expect(facts?.textContent).toContain('eval.defaultsGate = false');
    expect(facts?.textContent).toContain('τ = 1/(1+1) = 0.50');
    expect(facts?.textContent).toContain('iris 0.13.0');
    expect(open.querySelector('[data-ladder-toggle]')?.textContent).toBe('Hide how it was computed');
  });

  it('a verdict by the risk layer shows the estimate, its interval, the deciding classes and the confidence', () => {
    const { container } = panel({
      passed: false,
      verdict: {
        state: 'fail',
        passed: false,
        basis: 'risk_over_loss',
        by: ['pii_leak'],
        risk: { pBad: 0.62, lo: 0.41, hi: 0.8, perClass: { pii_leak: 0.62 }, assumptions: [] },
        confidence: 'marginal',
      },
      interpretations: [],
    });
    expect(container.querySelector('[data-verdict-state]')?.textContent).toBe('FAIL');
    expect(container.querySelector('[data-basis]')?.getAttribute('data-basis')).toBe('risk_over_loss');
    expect(container.querySelector('[data-by]')?.textContent).toBe('by pii_leak');
    expect(container.querySelector('[data-risk]')?.textContent).toBe('p(bad) 0.62 [0.41, 0.80]');
    expect(container.querySelector('[data-confidence="marginal"]')).not.toBeNull();
  });

  it('a critical rule that could not judge: UNKNOWN, the notice, and the block sentence', () => {
    const { container } = panel({
      passed: false,
      verdict: { state: 'unknown', passed: false, basis: 'critical_unknown', by: ['no_pii'], risk: null },
      criticalSkipped: ['no_pii'],
      interpretations: [
        { severity: 'block', addressee: 'operator', text: 'A critical check was asked and could not answer (no_pii).', configKey: 'eval.onCriticalSkipped' },
      ],
    });
    expect(container.querySelector('[data-verdict-state]')?.textContent).toBe('UNKNOWN');
    expect(container.querySelector('[data-critical-skipped="no_pii"]')?.textContent).toContain('unknown, not clean');
    expect(container.querySelector('[data-interpretation="block"]')?.getAttribute('data-config-key')).toBe('eval.onCriticalSkipped');
  });

  it('a veto names the rule', () => {
    const { container } = panel({
      passed: false,
      verdict: { state: 'fail', passed: false, basis: 'detector_veto', by: ['no_pii'], risk: null },
      criticalFailures: ['no_pii'],
    });
    expect(container.querySelector('[data-vetoed-by="no_pii"]')?.textContent).toContain('a critical rule failed');
  });

  it('an evaluation from before the composer says it has no verdict and offers no ladder', () => {
    const { container } = panel({ verdict: null, coverage: null, interpretations: null, provenance: null });
    expect(container.querySelector('[data-no-verdict]')?.textContent).toBe(NO_VERDICT_TEXT);
    expect(container.querySelector('[data-ladder-toggle]')).toBeNull();
    expect(container.querySelector('[data-verdict-state]')?.textContent).toBe('PASS');
  });

  it('has no axe violations closed, open, unknown or without a verdict', async () => {
    for (const over of [
      {},
      { expanded: true },
      { verdict: { state: 'unknown', passed: false, basis: 'critical_unknown', by: ['no_pii'], risk: null } as Verdict, criticalSkipped: ['no_pii'] },
      { verdict: null, coverage: null, interpretations: null, provenance: null },
    ]) {
      const { container, unmount } = panel(over);
      expect((await axe(container)).violations).toEqual([]);
      unmount();
    }
  });
});
