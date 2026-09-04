/*
 * EvalDetailCard — a skipped rule is "not judged", never "failed".
 *
 * The server ships a skipped rule with `passed: false, score: 0` as
 * placeholders plus `skipped: true`. Until 0.8.1 this card (used by the
 * /evals modal and the trace detail page) branched on `passed` alone, so
 * "no cost was supplied" drew the same red cross as "an SSN was found" —
 * the exact conflation #406 closed on the API (`categories[].passed: null`)
 * and the moment page already avoided. This test fails on the old card.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import type { EvalResult } from '../../../src/api/types';
import { EvalDetailCard } from '../../../src/components/evals/EvalDetailCard';

function evalResult(): EvalResult {
  return {
    id: 'eval-1',
    trace_id: 'trace-1',
    eval_type: 'all',
    output_text: 'The bind address is 127.0.0.1.',
    score: 0.9,
    passed: true,
    rule_results: [
      { ruleName: 'no_pii', passed: true, score: 1, message: 'No PII detected' },
      { ruleName: 'no_stub_output', passed: false, score: 0, message: 'Stub marker found: TODO' },
      {
        ruleName: 'cost_under_threshold',
        passed: false,
        score: 0,
        message: 'Skipped: no cost data supplied',
        skipped: true,
        skipReason: 'no cost data',
      },
    ],
    suggestions: [],
  };
}

describe('EvalDetailCard — skipped versus failed', () => {
  it('renders a skipped rule as not judged, with no red cross and no score badge', () => {
    const { container } = render(<EvalDetailCard evalResult={evalResult()} />);

    const rows = container.querySelectorAll('.eval-card__rule');
    expect(rows).toHaveLength(3);

    const skippedRow = container.querySelector('[data-rule-state="skipped"]');
    expect(skippedRow).not.toBeNull();
    expect(skippedRow?.textContent).toContain('cost_under_threshold');
    expect(skippedRow?.textContent).toContain('SKIPPED');
    expect(skippedRow?.textContent).not.toContain('✗');
    expect(skippedRow?.textContent).toContain('Skipped: ');

    const failedRow = container.querySelector('[data-rule-state="failed"]');
    expect(failedRow?.textContent).toContain('no_stub_output');
    expect(failedRow?.textContent).toContain('✗');
    expect(failedRow?.textContent).toContain('Failed: ');

    const passedRow = container.querySelector('[data-rule-state="passed"]');
    expect(passedRow?.textContent).toContain('no_pii');
    expect(passedRow?.textContent).toContain('✓');

    // Exactly one failure mark on the card: the skipped rule must not add one.
    expect((container.textContent?.match(/✗/g) ?? []).length).toBe(1);
  });

  it('a rule with no skipped field still renders as pass or fail (older stored rows)', () => {
    const r = evalResult();
    r.rule_results = [{ ruleName: 'min_output_length', passed: false, score: 0.2, message: 'too short' }];
    const { container } = render(<EvalDetailCard evalResult={r} />);
    expect(container.querySelector('[data-rule-state="failed"]')).not.toBeNull();
    expect(container.querySelector('[data-rule-state="skipped"]')).toBeNull();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<EvalDetailCard evalResult={evalResult()} />);
    const results = await axe(container);
    expect(results.violations).toEqual([]);
    // The state is announced to screen readers, not only drawn in colour.
    expect(screen.getByText('Skipped:')).toBeTruthy();
  });
});
