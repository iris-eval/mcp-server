/*
 * Checksums and the sentence splitter (arc 3, A3-2b; acceptance row V5).
 *
 * The checksums exist so a shape match becomes a structure match — and,
 * specifically, so the normalisation pass cannot manufacture a card number
 * out of circled digits. The splitter exists because two rules had two
 * different wrong answers to "where does a sentence end".
 */
import { describe, expect, it } from 'vitest';
import { luhn, iban, ssnStructure } from '../../../src/eval/text/checksums.js';
import { sentencesOf, countSentences } from '../../../src/eval/text/sentences.js';
import { normalise } from '../../../src/eval/text/normalise.js';

describe('luhn', () => {
  it('accepts the published test numbers of every major network', () => {
    for (const n of ['4242424242424242', '5555555555554444', '4000000000000002', '378282246310005', '6011111111111117', '3530111333300000']) {
      expect(luhn(n), n).toBe(true);
    }
  });

  it('accepts them with the separators a card number is written with', () => {
    expect(luhn('4242 4242 4242 4242')).toBe(true);
    expect(luhn('4242-4242-4242-4242')).toBe(true);
  });

  it('rejects a digit run that is merely sixteen digits long', () => {
    expect(luhn('4242424242424243')).toBe(false);
    expect(luhn('1234567890123456')).toBe(false);
    expect(luhn('0000000000000001')).toBe(false);
  });

  it('rejects runs that are too short or too long to be a card', () => {
    expect(luhn('42424242424')).toBe(false); // 11 digits
    expect(luhn('42424242424242424242')).toBe(false); // 20 digits
  });

  it('rejects anything carrying a character a card number never has', () => {
    expect(luhn('4242.4242.4242.4242')).toBe(false);
    expect(luhn('4242a242424242 42')).toBe(false);
  });

  it('is what stops the fold from manufacturing a card number', () => {
    // Circled digits are not a card number; NFKC turns them into one shape.
    const circled = '①②③④⑤⑥⑦⑧⑨⓪①②③④⑤⑥';
    const folded = normalise(circled).text;
    expect(folded).toMatch(/^\d{16}$/);
    expect(luhn(folded)).toBe(false);
  });
});

describe('iban', () => {
  it('accepts published examples', () => {
    for (const n of ['GB82WEST12345698765432', 'DE89370400440532013000', 'FR1420041010050500013M02606']) {
      expect(iban(n), n).toBe(true);
    }
  });
  it('accepts spaced form and rejects a wrong check pair', () => {
    expect(iban('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(iban('GB83WEST12345698765432')).toBe(false);
  });
  it('rejects a token that merely has the shape', () => {
    expect(iban('AB12CDEFGHIJKLMNOP')).toBe(false);
    expect(iban('NOTANIBAN')).toBe(false);
  });
});

describe('ssnStructure', () => {
  it('accepts a real-shaped number, including the canonical fake', () => {
    expect(ssnStructure('536-22-8145')).toBe(true);
    // Deliberate: it is what people paste to test the detector.
    expect(ssnStructure('123-45-6789')).toBe(true);
  });
  it('rejects the areas, groups and serials never issued', () => {
    expect(ssnStructure('000-22-8145')).toBe(false);
    expect(ssnStructure('666-22-8145')).toBe(false);
    expect(ssnStructure('900-22-8145')).toBe(false);
    expect(ssnStructure('536-00-8145')).toBe(false);
    expect(ssnStructure('536-22-0000')).toBe(false);
  });
  it('rejects anything not in the format', () => {
    expect(ssnStructure('536228145')).toBe(false);
    expect(ssnStructure('536-2-8145')).toBe(false);
  });
});

describe('sentencesOf', () => {
  it('splits ordinary prose', () => {
    expect(sentencesOf('The report is ready. It covers March. Ship it!')).toEqual([
      'The report is ready.',
      'It covers March.',
      'Ship it!',
    ]);
  });

  it('does not break on a decimal — the defect that cost sentence_count 43% of its family', () => {
    expect(countSentences('The latency is 3.5 seconds.')).toBe(1);
    expect(countSentences('Version 1.2.3 shipped on time.')).toBe(1);
    expect(countSentences('It rose 0.5% then fell 1.25%.')).toBe(1);
  });

  it('does not break after an abbreviation or an initial', () => {
    expect(countSentences('Dr. Chen approved the change.')).toBe(1);
    expect(countSentences('Use the cache, e.g. Redis, for reads.')).toBe(1);
    expect(countSentences('J. Smith filed the report.')).toBe(1);
    expect(countSentences('Acme Inc. shipped it.')).toBe(1);
    expect(countSentences('Compare 4 vs. 5 workers.')).toBe(1);
  });

  it('still breaks where a sentence really ends after an abbreviation-shaped word', () => {
    expect(countSentences('It was fun. Then we left.')).toBe(2);
    expect(countSentences('We shipped in Oct. The rollout held.')).toBe(2);
  });

  it('keeps a terminator cluster and the closing quote with its sentence', () => {
    expect(sentencesOf('Really?! Yes.')).toEqual(['Really?!', 'Yes.']);
    expect(sentencesOf('He said "go." She left.')).toEqual(['He said "go."', 'She left.']);
  });

  it('does not split inside a URL or a version string', () => {
    expect(countSentences('See https://iris-eval.com/proof for the numbers.')).toBe(1);
    expect(countSentences('Upgrade to v0.10.0 today.')).toBe(1);
  });

  it('treats a blank line as a break, so a bullet list is not one long sentence', () => {
    expect(countSentences('First item\n\nSecond item\n\nThird item')).toBe(3);
  });

  it('a wrapped paragraph is one sentence', () => {
    expect(countSentences('This sentence is wrapped\nacross two lines.')).toBe(1);
  });

  it('text with no terminator is one sentence, and empty text is none', () => {
    expect(countSentences('no terminator here')).toBe(1);
    expect(countSentences('   ')).toBe(0);
    expect(countSentences('')).toBe(0);
  });
});
