/*
 * The label control on a rule-result row: only on a FAILED
 * row, only when the page supplies a handler; the current label is
 * pressed; a click hands the rule and the value back.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import { RuleResultRow } from '../../../src/components/evals/RuleResultRow';
import type { EvalRuleResult } from '../../../src/api/types';

const fired: EvalRuleResult = { ruleName: 'no_stub_output', passed: false, score: 0, message: 'Stub marker found: TODO', kind: 'inference', role: 'risk' };
const passed: EvalRuleResult = { ruleName: 'no_pii', passed: true, score: 1, message: 'No PII detected', kind: 'detection', role: 'risk' };
const skipped: EvalRuleResult = { ruleName: 'cost_under_threshold', passed: false, score: 0, message: 'no cost', skipped: true, skipReason: 'no cost data' };

describe('RuleResultRow — the label control (D-8)', () => {
  it('appears on a failed row with a handler, and hands back the rule and the value', () => {
    const onLabel = vi.fn();
    const { container } = render(<RuleResultRow result={fired} onLabel={onLabel} />);
    const control = container.querySelector('[data-label-control="no_stub_output"]')!;
    expect(control).not.toBeNull();
    expect(control.getAttribute('data-label')).toBe('none');
    const buttons = control.querySelectorAll('button');
    expect([...buttons].map((b) => b.textContent)).toEqual(['right', 'wrong']);
    expect([...buttons].every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true);
    fireEvent.click(buttons[1]);
    expect(onLabel).toHaveBeenCalledWith('no_stub_output', 'wrong');
  });

  it('shows the current label pressed', () => {
    const { container } = render(<RuleResultRow result={fired} label="right" onLabel={vi.fn()} />);
    const control = container.querySelector('[data-label-control="no_stub_output"]')!;
    expect(control.getAttribute('data-label')).toBe('right');
    const [right, wrong] = control.querySelectorAll('button');
    expect(right.getAttribute('aria-pressed')).toBe('true');
    expect(wrong.getAttribute('aria-pressed')).toBe('false');
  });

  it('is absent on a passed row, on a skipped row, and without a handler: a label is a judgement on a fire', () => {
    expect(render(<RuleResultRow result={passed} onLabel={vi.fn()} />).container.querySelector('[data-label-control]')).toBeNull();
    expect(render(<RuleResultRow result={skipped} onLabel={vi.fn()} />).container.querySelector('[data-label-control]')).toBeNull();
    expect(render(<RuleResultRow result={fired} />).container.querySelector('[data-label-control]')).toBeNull();
  });

  it('is disabled while a label is being written', () => {
    const { container } = render(<RuleResultRow result={fired} onLabel={vi.fn()} labelBusy />);
    expect([...container.querySelectorAll('[data-label-control] button')].every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('has no axe violations', async () => {
    const { container } = render(<RuleResultRow result={fired} label="wrong" onLabel={vi.fn()} />);
    expect((await axe(container)).violations).toEqual([]);
  });
});
