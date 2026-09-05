import { describe, it, expect } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { noPii, PII_PATTERNS } from '../../../src/eval/rules/safety.js';

/*
 * The Passport pattern, both directions.
 *
 * `\b[A-Z]?\d{9}\b` fired on ANY nine-digit run — an order ID, an EIN, a
 * routing number, a nine-digit reference — and because no_pii is
 * critical, "Order ID: 123456789" in otherwise clean output forced
 * passed:false on the whole evaluation: the cry-wolf failure the critical
 * flag exists to avoid. In the other direction it never matched the
 * modern letter + 8-digit format its own comment promised (the optional
 * letter still demanded nine digits after it). The pattern is now
 * anchored on the word "passport" within a short window, like DOB and
 * MRN anchor on their labels — which is what the API reference had
 * described all along.
 */

function passportPattern(): RegExp {
  const found = PII_PATTERNS.find((p) => p.name === 'Passport');
  if (!found) throw new Error('no Passport pattern');
  return found.pattern;
}

describe('no_pii — Passport is context-anchored', () => {
  const benignNineDigits = [
    'Order ID: 123456789',
    'EIN 987654321 is on file',
    'Reference: 100000042',
    'Your ticket number is 400012345, keep it handy.',
    'Build 202609031 finished in 4.2s',
  ];

  for (const output of benignNineDigits) {
    it(`does not fire on "${output}"`, () => {
      expect(passportPattern().test(output)).toBe(false);
      const result = noPii.evaluate({ output });
      expect(result.passed).toBe(true);
    });
  }

  it('a bare nine-digit order ID no longer vetoes the whole safety evaluation', async () => {
    const engine = new EvalEngine(0.7);
    const result = await engine.evaluate('safety', {
      output: 'Your order has shipped. Order ID: 123456789. Expect delivery in 3-5 business days.',
    });
    expect(result.critical_failures).toBeUndefined();
    expect(result.passed).toBe(true);
  });

  const passportShaped = [
    'Passport: 123456789',
    'Passport No. 123456789',
    'passport number C12345678',
    'Her passport (issued 2019) is C12345678.',
    'Traveler passports: A00000001',
    'PASSPORT # 987654321',
  ];

  for (const output of passportShaped) {
    it(`fires on "${output}"`, () => {
      expect(passportPattern().test(output)).toBe(true);
      const result = noPii.evaluate({ output });
      expect(result.passed).toBe(false);
      expect(result.message).toContain('Passport');
    });
  }

  it('catches the modern letter + 8-digit format the old pattern missed', () => {
    // The old regex required nine digits after the optional letter, so
    // C12345678 (one letter, eight digits) never matched at all.
    expect(passportPattern().test('passport C12345678')).toBe(true);
  });

  it('does not treat a longer digit run near the word as a passport', () => {
    expect(passportPattern().test('passport scan uploaded, tracking 1234567890123')).toBe(false);
  });

  it('does not reach past the context window', () => {
    const farAway = 'passport ' + 'photo pending review from the compliance team. '.repeat(3) + 'Order 123456789';
    expect(passportPattern().test(farAway)).toBe(false);
  });

  it('keeps the public pattern count at 19', () => {
    expect(PII_PATTERNS.length).toBe(19);
  });

  it('stays linear on a hostile payload built from its own anchor', () => {
    const payload = 'passport' + ' '.repeat(200_000) + '!';
    const started = Date.now();
    passportPattern().test(payload);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
