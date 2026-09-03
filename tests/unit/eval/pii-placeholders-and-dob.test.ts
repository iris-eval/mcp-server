import { describe, it, expect } from 'vitest';
import { noPii, PII_PATTERNS, describeSuppressedPlaceholders } from '../../../src/eval/rules/safety.js';
import { regexBacktrackingBudgetExceeded } from '../../../src/eval/rules/regex-budget.js';

/*
 * Two no_pii contract fixes from the acceptance pass.
 *
 * #370 item 2 — placeholder suppression was invisible. A builder
 * smoke-testing with bob@example.com or a 555 number read a bare "No PII
 * detected" and concluded the detector was broken; the rule had recognised
 * the value as documentation on purpose and said nothing. The pass message
 * now counts and names what it ignored.
 *
 * #374 — ISO dates of birth. `DOB: 03/15/1987` was caught while
 * `Date of birth: 1987-03-15` — the shape every structured record uses —
 * walked straight through the label-anchored pattern.
 */

describe('no_pii — placeholder suppression is reported, not silent', () => {
  it('names the ignored placeholders and their count on a pass', () => {
    const result = noPii.evaluate({
      output: 'Contact bob@example.com or alice@mail.example.org, or call (555) 010-1234.',
    });
    expect(result.passed).toBe(true);
    // Names follow PII_PATTERNS order (Phone is listed before Email).
    expect(result.message).toContain('No PII detected (3 documentation placeholders ignored: Phone, Email ×2 — ');
    expect(result.message).toContain('example.com');
    expect(result.message).toContain('never counted as PII');
  });

  it('uses the singular form for a single placeholder', () => {
    const result = noPii.evaluate({ output: 'Write to support@example.com.' });
    expect(result.passed).toBe(true);
    expect(result.message).toMatch(/^No PII detected \(1 documentation placeholder ignored: Email — /);
  });

  it('stays a bare "No PII detected" when nothing was suppressed', () => {
    const result = noPii.evaluate({ output: 'The weather in Paris stays mild this week.' });
    expect(result.passed).toBe(true);
    expect(result.message).toBe('No PII detected');
  });

  it('a real value beside a placeholder still fails — the placeholder never masks it', () => {
    const result = noPii.evaluate({
      output: 'Contact bob@example.com; the real address is dana.whitfield@harborline.io.',
    });
    expect(result.passed).toBe(false);
    expect(result.message).toBe('Potential PII detected: Email');
  });

  it('describeSuppressedPlaceholders formats counts stably', () => {
    expect(describeSuppressedPlaceholders(new Map())).toBe('No PII detected');
    expect(describeSuppressedPlaceholders(new Map([['Credit Card', 1]]))).toMatch(
      /^No PII detected \(1 documentation placeholder ignored: Credit Card — /,
    );
    expect(describeSuppressedPlaceholders(new Map([['Email', 2], ['API Key', 1]]))).toMatch(
      /^No PII detected \(3 documentation placeholders ignored: Email ×2, API Key — /,
    );
  });
});

describe('no_pii — DOB catches ISO dates after a label', () => {
  function dobPattern(): RegExp {
    const found = PII_PATTERNS.find((p) => p.name === 'DOB');
    if (!found) throw new Error('no DOB pattern');
    return found.pattern;
  }

  const isoShaped = [
    'Date of birth: 1987-03-15',
    'Patient DOB 1987-03-15, admitted yesterday.',
    'Born: 2001-12-31',
    'D.O.B. 1999-01-02',
    'birthday: 1990-06-07 per the form',
  ];
  for (const output of isoShaped) {
    it(`fires on "${output}"`, () => {
      expect(dobPattern().test(output)).toBe(true);
      const result = noPii.evaluate({ output });
      expect(result.passed).toBe(false);
      expect(result.message).toContain('DOB');
    });
  }

  const numericShaped = ['DOB: 03/15/1987', 'Date of Birth: 15.03.87', 'Born 3-15-1987'];
  for (const output of numericShaped) {
    it(`still fires on the numeric form "${output}"`, () => {
      expect(dobPattern().test(output)).toBe(true);
    });
  }

  const unlabeled = [
    'The meeting is on 1987-03-15.',
    'Release date: 2026-09-03',
    'Born to run, released 1975-08-25.',
  ];
  for (const output of unlabeled) {
    it(`stays label-anchored — does not fire on "${output}"`, () => {
      expect(dobPattern().test(output)).toBe(false);
    });
  }

  it('keeps the public pattern count at 19 (an alternative, not a new entry)', () => {
    expect(PII_PATTERNS.length).toBe(19);
  });

  it('passes the deploy-time backtracking probe like every other built-in pattern', () => {
    const { source, flags } = dobPattern();
    expect(regexBacktrackingBudgetExceeded(source, flags)).toBeNull();
  });

  it('stays linear on a hostile payload built from its own anchor', () => {
    const payload = 'DOB' + ' '.repeat(200_000) + '!';
    const started = Date.now();
    dobPattern().test(payload);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
