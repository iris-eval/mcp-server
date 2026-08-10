import { describe, it, expect } from 'vitest';
import { PII_PATTERNS } from '../../../src/eval/rules/safety.js';

/*
 * PII patterns run against ATTACKER-CONTROLLED text. Agent output is
 * untrusted by definition, and any agent that summarises a web page, reads
 * email, or handles user tickets can be handed a crafted string that
 * reaches evaluate_output. Node is single-threaded, so one pathological
 * match wedges the entire server — no crash, no error, just a server that
 * stops answering.
 *
 * Two patterns were superlinear:
 *   - Medical Record Number / DOB used `\s*[:.]?\s*`. Two adjacent
 *     unbounded whitespace quantifiers give N+1 ways to split a run of N
 *     spaces, each failing at the trailing class. 'MRN' + N spaces + '!'
 *     measured 31ms @4k, 118ms @8k, 468ms @16k — quadratic — and did not
 *     finish at the 1MB express.json body limit.
 *   - Email's local part was unbounded, so on text with no '@' every one
 *     of N start positions consumed the rest of the string before failing.
 *     'a@' + 'a.'x32000 took 3.5 seconds.
 *
 * Thresholds below are deliberately loose (CI runners are noisy and slow).
 * They are not benchmarks — they are a tripwire. Quadratic behaviour on
 * these payload sizes takes minutes, so anything under a second means the
 * pattern is still linear-ish; anything over means a quantifier regressed.
 */

const BUDGET_MS = 1_000;

function timeMatch(pattern: RegExp, text: string): number {
  const started = Date.now();
  pattern.test(text);
  return Date.now() - started;
}

function patternNamed(name: string): RegExp {
  const found = PII_PATTERNS.find((p) => p.name === name);
  if (!found) throw new Error(`no PII pattern named ${name}`);
  return found.pattern;
}

describe('PII patterns resist ReDoS', () => {
  const payloads: Array<[string, string]> = [
    ['Medical Record Number', 'MRN' + ' '.repeat(200_000) + '!'],
    ['DOB', 'DOB' + ' '.repeat(200_000) + '!'],
    ['Email', 'a@' + 'a.'.repeat(100_000) + '!'],
  ];

  for (const [name, payload] of payloads) {
    it(`${name} completes on a ${payload.length}-char adversarial payload`, () => {
      expect(timeMatch(patternNamed(name), payload)).toBeLessThan(BUDGET_MS);
    });
  }

  it('every pattern completes on a large benign payload', () => {
    // Realistic worst case: a long document with no PII in it at all.
    const document = 'The quick brown fox jumps over the lazy dog. '.repeat(5_000);
    for (const { name, pattern } of PII_PATTERNS) {
      expect(timeMatch(pattern, document), `${name} exceeded the budget`).toBeLessThan(BUDGET_MS);
    }
  });
});

describe('PII patterns still detect what they claim to', () => {
  // Bounding a quantifier is only correct if detection is unchanged — this
  // is the half a pure timing test would miss.
  const cases: Array<[string, string, boolean]> = [
    ['Email', 'contact jane.doe%test+x@sub.example.co.uk please', true],
    ['Email', 'a@b.io', true],
    ['Email', 'no address in this sentence', false],
    ['DOB', 'DOB: 01/02/1990', true],
    ['DOB', 'Date of Birth 1-2-90', true],
    ['DOB', 'Born. 12.31.2001', true],
    ['DOB', 'born yesterday', false],
    ['Medical Record Number', 'MRN: A1B2C3D4', true],
    ['Medical Record Number', 'Medical Record No. 123456', true],
    ['Medical Record Number', 'MRN 9988776655', true],
    ['Medical Record Number', 'no record here', false],
  ];

  for (const [name, text, expected] of cases) {
    it(`${name} ${expected ? 'matches' : 'ignores'} ${JSON.stringify(text)}`, () => {
      expect(patternNamed(name).test(text)).toBe(expected);
    });
  }
});
