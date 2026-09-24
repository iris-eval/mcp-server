/*
 * One row, every stamped field. The proposition per test is the field:
 * it renders, with its own hook (a data- attribute) and its own words.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { RuleResultRow } from '../../../src/components/evals/RuleResultRow';
import { PRE_STAMP_TEXT } from '../../../src/components/evals/ruleResultText';
import type { BuiltInRuleMeta, EvalRuleResult, RuleProofSummary } from '../../../src/api/types';

const fired: EvalRuleResult = {
  ruleName: 'no_pii',
  passed: false,
  score: 0,
  message: 'PII detected: 1 email address',
  kind: 'detection',
  role: 'veto',
  critical: true,
  criticalSource: 'default',
  origin: 'built-in',
  question: 'safe_output',
  classes: ['pii_leak'],
  ruleVersion: 3,
  evidence: [
    { type: 'span', source: 'output', start: 8, end: 24, label: 'email address' },
    { type: 'pattern', name: 'email', count: 1 },
  ],
  uncertainty: {
    basis: 'published_accuracy',
    fired: true,
    ppv: { point: 0.71, lo: 0.58, hi: 0.82 },
    prior: { pi: 0.05, source: 'default' },
    corpus: { n: 141, tp: 20, fp: 8, fn: 5, tn: 108, version: 'a4e0e6d77d07', release: '0.13.0', labelling: 'same-model' },
  },
};

const meta: BuiltInRuleMeta = {
  name: 'no_pii',
  category: 'safety',
  description: 'Fails when the output contains an email address, a phone number or a card number.',
  weight: 1,
  kind: 'detection',
  mechanism: 'pattern',
  needs: ['output'],
  question: 'safe_output',
  classes: ['pii_leak'],
  version: 3,
  critical: true,
  criticalSource: 'default',
};

function row(result: EvalRuleResult, extra: Partial<React.ComponentProps<typeof RuleResultRow>> = {}) {
  return render(<RuleResultRow result={result} {...extra} />);
}

describe('RuleResultRow: every stamped field has a place', () => {
  it('a failed row: state, kind, role, criticality with source, message, score', () => {
    const { container } = row(fired);
    const root = container.querySelector('[data-rule-state]')!;
    expect(root.getAttribute('data-rule-state')).toBe('failed');
    expect(root.getAttribute('data-rule-name')).toBe('no_pii');
    expect(screen.getByText('Failed:')).toBeTruthy();
    expect(container.querySelector('[data-kind="detection"]')?.textContent).toBe('detection');
    expect(container.querySelector('[data-role="veto"]')?.textContent).toBe('veto');
    expect(container.querySelector('[data-critical-source="default"]')?.textContent).toBe('critical · default');
    expect(screen.getByText('PII detected: 1 email address')).toBeTruthy();
  });

  it('evidence spans are quoted from the text the page has, and patterns say their count', () => {
    const { container } = row(fired, { texts: { output: 'Contact john.doe@example.com for the invoice.' } });
    const items = container.querySelectorAll('[data-evidence-type]');
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute('data-evidence-type')).toBe('span');
    expect(items[0].textContent).toContain('output[8–24] · email address');
    expect(items[0].querySelector('q')?.textContent).toBe('john.doe@example');
    expect(items[1].textContent).toBe('pattern email ×1');
  });

  it('a span without the text shows its offsets and no quote', () => {
    const { container } = row(fired);
    expect(container.querySelector('[data-evidence-type="span"] q')).toBeNull();
    expect(container.querySelector('[data-evidence-type="span"]')?.textContent).toContain('output[8–24]');
  });

  it('tool-call evidence links to the call the page names', () => {
    const r: EvalRuleResult = {
      ...fired,
      ruleName: 'no_tool_loop',
      evidence: [{ type: 'toolCall', index: 3, toolName: 'search', label: 'fourth identical call' }],
      uncertainty: undefined,
    };
    const { container } = row(r, { callHref: (i) => `/traces/t-1#call-${i}` });
    const link = container.querySelector('a[data-show-call="3"]') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe('/traces/t-1#call-3');
    expect(link.textContent).toBe('call #3 search · fourth identical call');
  });

  it('the error bar: a fired detection shows its PPV interval and names its basis', () => {
    const { container } = row(fired);
    const u = container.querySelector('[data-uncertainty="published_accuracy"]');
    expect(u?.textContent).toBe('PPV 0.71 [0.58, 0.82]');
  });

  it('the error bar: a quiet detection shows its miss rate', () => {
    const quiet: EvalRuleResult = {
      ...fired,
      passed: true,
      score: 1,
      message: 'No PII detected',
      evidence: [],
      uncertainty: {
        basis: 'published_accuracy',
        fired: false,
        missRate: { point: 0.2, lo: 0.09, hi: 0.39 },
        prior: { pi: 0.05, source: 'config' },
        corpus: { n: 141, tp: 20, fp: 8, fn: 5, tn: 108, version: 'a4e0e6d77d07', release: '0.13.0', labelling: 'same-model' },
      },
    };
    const { container } = row(quiet);
    expect(container.querySelector('[data-rule-state]')?.getAttribute('data-rule-state')).toBe('passed');
    expect(container.querySelector('[data-uncertainty]')?.textContent).toBe('miss rate 0.20 [0.09, 0.39]');
  });

  it('the error bar: policy, definition, local labels and unmeasured each say what they are', () => {
    const bases: Array<[EvalRuleResult['uncertainty'], string]> = [
      [{ basis: 'policy' }, 'policy'],
      [{ basis: 'definition', conformance: { n: 12, matched: 12 } }, 'conformance 12/12'],
      [{ basis: 'local_labels', precision: { point: 0.9, lo: 0.7, hi: 0.97 }, n: 24 }, 'local precision 0.90 [0.70, 0.97]'],
      [{ basis: 'unmeasured', why: 'no family yet' }, 'unmeasured'],
      [{ basis: 'self_consistency', samples: 5, voteFraction: 0.8, scoreSd: 0.1 }, '5 samples · 80% agree'],
    ];
    for (const [uncertainty, label] of bases) {
      const { container, unmount } = row({ ...fired, evidence: [], uncertainty });
      expect(container.querySelector('[data-uncertainty]')?.textContent).toBe(label);
      unmount();
    }
  });

  it('a row with no error bar of its own shows the published interval when the page has the table', () => {
    const proof: RuleProofSummary = {
      n: 141,
      tp: 20,
      fp: 8,
      fn: 5,
      tn: 108,
      precision: 0.714,
      recall: 0.8,
      f1: 0.755,
      ci95: { precision: [0.53, 0.85], recall: [0.6, 0.92], f1: [0.6, 0.86] },
      ppvAt: {},
      corpusVersion: 'a4e0e6d77d07',
      release: '0.13.0',
      labelling: 'same-model',
    };
    const { container } = row({ ...fired, uncertainty: undefined, evidence: [] }, { proof });
    expect(container.querySelector('[data-uncertainty="published_table"]')?.textContent).toBe(
      'published precision 0.71 [0.53, 0.85]',
    );
  });

  it('a skipped row: the skip reason, its class, no score badge, and a screen-reader label', () => {
    const skipped: EvalRuleResult = {
      ruleName: 'output_relevant_to_input',
      passed: false,
      score: 0,
      message: 'skipped',
      skipped: true,
      skipReason: 'input was not supplied',
      skipClass: 'not_applicable',
      kind: 'inference',
      role: 'risk',
    };
    const { container } = row(skipped);
    expect(container.querySelector('[data-rule-state]')?.getAttribute('data-rule-state')).toBe('skipped');
    expect(screen.getByText('Skipped:')).toBeTruthy();
    expect(container.querySelector('[data-skip-reason]')?.textContent).toBe(
      'input was not supplied — Not applicable: the rule had nothing to judge on this input.',
    );
    expect(screen.getByText('SKIPPED')).toBeTruthy();
  });

  it('a measurement shows its value with its unit', () => {
    const m: EvalRuleResult = {
      ruleName: 'verbosity_ratio',
      passed: true,
      score: 1,
      message: 'ratio 1.4',
      kind: 'measurement',
      role: 'advisory',
      value: { stat: 'ratio', unit: 'x', value: 1.4 },
      uncertainty: { basis: 'policy' },
    };
    const { container } = row(m);
    expect(container.querySelector('[data-measured="ratio"]')?.textContent).toBe('ratio 1.4 x');
  });

  it('truncated evidence is said', () => {
    const { container } = row({ ...fired, evidenceIncomplete: true });
    expect(container.querySelector('[data-evidence-incomplete]')).not.toBeNull();
  });

  it('the definition sits behind one disclosure when the page has the roster', () => {
    const { container } = row(fired, { meta });
    const details = container.querySelector('details[data-definition="no_pii"]');
    expect(details).not.toBeNull();
    expect(details?.textContent).toContain('Fails when the output contains an email address');
    expect(details?.textContent).toContain('Needs: output');
    expect(details?.textContent).toContain('Mechanism: pattern');
    expect(details?.textContent).toContain('Rule version: 3');
  });

  it('a row stamped before 0.9.0 says so instead of showing blanks', () => {
    const old: EvalRuleResult = { ruleName: 'min_output_length', passed: true, score: 1, message: 'OK' };
    const { container } = row(old);
    expect(container.querySelector('[data-pre-stamp]')?.textContent).toBe(PRE_STAMP_TEXT);
    expect(container.querySelector('[data-kind]')).toBeNull();
    expect(container.querySelector('[data-role]')).toBeNull();
  });

  it('has no axe violations failed, passed, skipped or pre-stamp', async () => {
    const cases: EvalRuleResult[] = [
      fired,
      { ...fired, passed: true, score: 1, evidence: [] },
      { ruleName: 'x', passed: false, score: 0, message: 'skipped', skipped: true, skipReason: 'no input' },
      { ruleName: 'y', passed: true, score: 1, message: 'OK' },
    ];
    for (const c of cases) {
      const { container, unmount } = row(c, { meta, texts: { output: 'Contact john.doe@example.com now.' } });
      expect((await axe(container)).violations).toEqual([]);
      unmount();
    }
  });
});
