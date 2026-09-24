/*
 * The evaluation card's actions: the labels reach the rows,
 * the re-score button hands back the evaluation id, the notes read out,
 * and a re-scored row names what it superseded. Without the handlers the
 * card draws none of it.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import type { EvalResult } from '../../../src/api/types';
import { EvalDetailCard } from '../../../src/components/evals/EvalDetailCard';
import { labelSentence, reevaluateSentence, localPrecisionCell } from '../../../src/components/evals/labelText';

function evalResult(extra: Partial<EvalResult> = {}): EvalResult {
  return {
    id: 'eval-1',
    trace_id: 'trace-1',
    eval_type: 'all',
    output_text: 'TODO: write the summary.',
    score: 0.4,
    passed: false,
    rule_results: [
      { ruleName: 'no_pii', passed: true, score: 1, message: 'No PII detected', kind: 'detection' },
      { ruleName: 'no_stub_output', passed: false, score: 0, message: 'Stub marker found: TODO', kind: 'inference' },
    ],
    ...extra,
  };
}

describe('EvalDetailCard — labels and re-scoring', () => {
  it('draws no control and no actions without handlers', () => {
    const { container } = render(<EvalDetailCard evalResult={evalResult()} />);
    expect(container.querySelector('[data-label-control]')).toBeNull();
    expect(container.querySelector('.eval-card__actions')).toBeNull();
  });

  it('passes each row its label and hands a click back with the evaluation id', () => {
    const onLabel = vi.fn();
    const { container } = render(<EvalDetailCard evalResult={evalResult()} labels={new Map([['no_stub_output', 'right']])} onLabel={onLabel} />);
    const control = container.querySelector('[data-label-control="no_stub_output"]')!;
    expect(control.getAttribute('data-label')).toBe('right');
    fireEvent.click(control.querySelectorAll('button')[1]);
    expect(onLabel).toHaveBeenCalledWith('eval-1', 'no_stub_output', 'wrong');
    // The quiet row has no control.
    expect(container.querySelector('[data-label-control="no_pii"]')).toBeNull();
  });

  it('the re-score button hands back the id, shows busy, and the notes read out in a live region', () => {
    const onReevaluate = vi.fn();
    const { container, rerender } = render(<EvalDetailCard evalResult={evalResult()} onReevaluate={onReevaluate} labelNote="no_stub_output: 3 of 20 labels; 17 more before it replaces the published number here." />);
    const button = container.querySelector('[data-reevaluate="eval-1"]') as HTMLButtonElement;
    expect(button.textContent).toContain('Re-score');
    fireEvent.click(button);
    expect(onReevaluate).toHaveBeenCalledWith('eval-1');
    expect(container.querySelector('[data-eval-note]')!.textContent).toContain('17 more');
    expect(container.querySelector('[data-eval-note]')!.getAttribute('aria-live')).toBe('polite');

    rerender(<EvalDetailCard evalResult={evalResult()} onReevaluate={onReevaluate} reevaluating reevaluateNote="Re-scored: verdict fail → pass." />);
    const busy = container.querySelector('[data-reevaluate="eval-1"]') as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    // The re-score note wins over the label note when both exist.
    expect(container.querySelector('[data-eval-note]')!.textContent).toBe('Re-scored: verdict fail → pass.');
  });

  it('a re-scored evaluation names the row it superseded', () => {
    const { container } = render(
      <EvalDetailCard evalResult={evalResult({ provenance: { irisVersion: '0.14.0', rulesetHash: 'r', configHash: 'c', thresholds: { default: 0.7 }, corpusVersion: 'v', supersedes: 'eval_0123456789abcdef' } })} />,
    );
    expect(container.querySelector('[data-supersedes="eval_0123456789abcdef"]')!.textContent).toBe('re-scored from eval_0123456…');
  });

  it('the sentences', () => {
    expect(labelSentence({ min: 20, rule: null })).toBe('Label saved.');
    expect(
      labelSentence({
        min: 20,
        rule: { rule: 'no_stub_output', kind: 'inference', entersRisk: true, n: 3, right: 2, wrong: 1, precision: { point: 0.667, lo: 0.208, hi: 0.939 }, local: false, publishedPrecision: 0.96, fireRate: 0.3 },
      }),
    ).toBe('no_stub_output: 3 of 20 labels, local precision so far 67%; 17 more before it replaces the published number here.');
    expect(
      labelSentence({
        min: 20,
        rule: { rule: 'no_stub_output', kind: 'inference', entersRisk: true, n: 20, right: 2, wrong: 18, precision: { point: 0.1, lo: 0.028, hi: 0.301 }, local: true, publishedPrecision: 0.96, fireRate: 0.3 },
      }),
    ).toBe('no_stub_output: 20 labels — local precision 10% [3%–30%], in force on this deployment and in the risk estimate.');
    expect(reevaluateSentence({ before: { verdict: 'fail', passed: false }, after: { verdict: 'pass', passed: true }, changed: true })).toBe('Re-scored: verdict fail → pass.');
    expect(reevaluateSentence({ before: { verdict: 'fail', passed: false }, after: { verdict: 'fail', passed: false }, changed: false })).toBe('Re-scored: verdict unchanged (fail).');
    expect(localPrecisionCell({ n: 0, precision: null })).toBe('no labels yet');
    expect(localPrecisionCell({ n: 20, precision: { point: 0.1, lo: 0.028, hi: 0.301 } })).toBe('0.10 [0.03, 0.30] · n = 20');
  });

  it('has no axe violations with every action drawn', async () => {
    const { container } = render(
      <EvalDetailCard evalResult={evalResult()} labels={new Map([['no_stub_output', 'wrong']])} onLabel={vi.fn()} onReevaluate={vi.fn()} labelNote="saved" />,
    );
    expect((await axe(container)).violations).toEqual([]);
  });
});
