/*
 * The verdict chip must never read amber PARTIAL on a safety violation or
 * a critical-rule veto (#377 item 1). `verdict` is arithmetic over rule
 * counts; a PII leak with every other rule passing is "partial" by that
 * count and a hard fail by the engine.
 */
import { describe, it, expect } from 'vitest';
import { getVerdictVisual } from '../../../src/components/moments/significance';
import { TT } from '../../../src/components/shared/tooltipText';

const DANGER = 'var(--accent-error)';

describe('getVerdictVisual', () => {
  it('keeps the count-based chips when nothing escalates', () => {
    expect(getVerdictVisual('pass')).toMatchObject({ label: 'PASS', tooltip: TT.verdictPass });
    expect(getVerdictVisual('fail')).toMatchObject({ label: 'FAIL', color: DANGER });
    expect(getVerdictVisual('partial')).toMatchObject({ label: 'PARTIAL', color: 'var(--accent-warning)' });
    expect(getVerdictVisual('unevaluated')).toMatchObject({ label: 'UNEVALUATED' });
  });

  it('renders SAFETY FAIL in danger colour for a safety-violation moment, whatever the count says', () => {
    for (const verdict of ['partial', 'fail'] as const) {
      const chip = getVerdictVisual(verdict, { significanceKind: 'safety-violation' });
      expect(chip.label).toBe('SAFETY FAIL');
      expect(chip.color).toBe(DANGER);
      expect(chip.tooltip).toBe(TT.verdictSafetyFail);
      expect(chip.tooltip).not.toMatch(/mix of failures and passes/);
    }
  });

  it('renders SAFETY FAIL when a safety-category eval was vetoed by a deployed critical rule', () => {
    const chip = getVerdictVisual('partial', {
      significanceKind: 'normal-fail',
      vetoed: true,
      vetoedBySafety: true,
    });
    expect(chip.label).toBe('SAFETY FAIL');
    expect(chip.color).toBe(DANGER);
  });

  it('renders a danger FAIL (never PARTIAL) for a veto in a non-safety category', () => {
    const chip = getVerdictVisual('partial', { significanceKind: 'rule-collision', vetoed: true });
    expect(chip.label).toBe('FAIL');
    expect(chip.color).toBe(DANGER);
    expect(chip.tooltip).toBe(TT.verdictVetoed);
  });

  it('does not escalate other significance kinds', () => {
    expect(getVerdictVisual('partial', { significanceKind: 'cost-spike' }).label).toBe('PARTIAL');
    expect(getVerdictVisual('pass', { significanceKind: 'normal-pass' }).label).toBe('PASS');
  });
});
