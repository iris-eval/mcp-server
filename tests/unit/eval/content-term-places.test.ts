/*
 * contentTermPlaces is contentTerms with places.
 *
 * A rule that asks one text many questions by place (which terms stand in
 * the 300 characters after this phrase, which stood above it) took the
 * terms of each stretch again: 88,960 phrases in a megabyte of tool output
 * cost 2 s of CPU. contentTermPlaces gives every term once with the offset
 * of its word. It is another piece of code than contentTerms, so this holds
 * the two to the same terms in the same order, on texts built from the
 * things that make a tokenizer differ: camelCase, fenced code, letters
 * outside ASCII whose lower case is not.
 */
import { describe, expect, it } from 'vitest';
import { contentTermPlaces, contentTerms } from '../../../src/eval/terms.js';

describe('contentTermPlaces', () => {
  it('gives the terms contentTerms gives, each at the offset of its word', () => {
    const text = 'EvalEngine.evaluateAll() reads src/index.ts, then the migrations run.';
    const places = contentTermPlaces(text);
    expect(places.map(([term]) => term)).toEqual(contentTerms(text));
    expect(places).toEqual([
      ['eval', 0],
      ['engin', 4],
      ['evalu', 11],
      ['src', 31],
      ['index', 35],
      ['migr', 54],
      ['run', 65],
    ]);
  });

  it('leaves fenced code out, and what stands on either side of it is two words', () => {
    const text = 'before```ts\nconst hidden = 1;\n```after and ```unterminated fence';
    expect(contentTermPlaces(text).map(([term]) => term)).toEqual(contentTerms(text));
    expect(contentTermPlaces(text).map(([term]) => term)).not.toContain('hidden');
  });

  it('agrees with contentTerms on 20,000 generated texts', () => {
    let seed = 424242;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
    // Letters whose lower case is not their own length or script, written by code point so that each is the one meant:
    // a dotted capital I (its lower case is i and a combining dot), the Kelvin sign (its lower case is k), a title-case
    // digraph, a sharp s, a full-width F, an i with a diaeresis, an e with an acute, and two Chinese characters.
    const dottedI = String.fromCharCode(0x0130);
    const kelvin = String.fromCharCode(0x212a);
    const PIECES = [
      ...['evalEngine', 'EvalEngine.evaluateAll()', 'HTTPServer', 'parseCSVFile', 'src/index.ts', 'XMLHttpRequest', 'snake_case_name', 'kebab-case', 'iOS', 'macOS'],
      ...['the', 'and', 'Ledger', 'collector', 'migrations', 'Running', "don't", 'e.g.', 'STRASSE', 'a', 'ab', 'abc', 'ABC', 'aBc', 'K', 'x'.repeat(40)],
      ...['```', '```ts\nconst x = 1;\n```', '`inline`', '\n', ' ', '.', ',', '42', 'v1.2.3'],
      ...[`${dottedI}stanbul`, kelvin, `a${kelvin}b`, String.fromCharCode(0x01c5), String.fromCharCode(0x00df), `${String.fromCharCode(0xff26)}ull`],
      ...[`na${String.fromCharCode(0x00ef)}ve`, `caf${String.fromCharCode(0x00e9)}`, String.fromCharCode(0x5ffd, 0x7565)],
    ];
    for (let run = 0; run < 20_000; run += 1) {
      const text = Array.from({ length: 1 + Math.floor(rand() * 30) }, () => pick(PIECES)).join(pick(['', ' ', '\n']));
      const places = contentTermPlaces(text);
      expect(places.map(([term]) => term), JSON.stringify(text)).toEqual(contentTerms(text));
      for (const [, at] of places) expect(at >= 0 && at < text.length, JSON.stringify(text)).toBe(true);
    }
  }, 30_000); // 3.6 s under coverage on a CI runner, where the suite gives a test 5 s

  it('a letter outside ASCII is a letter only when its lower case is written a to z', () => {
    const kelvin = String.fromCharCode(0x212a);
    const dottedI = String.fromCharCode(0x0130);
    // The Kelvin sign lower-cases to k, so "bac" + sign + "up" is one word; the dotted capital I lower-cases to i and a combining dot, which ends the word after the i.
    for (const text of [`bac${kelvin}up`, `${dottedI}stanbul`, `m${dottedI}grations run`]) {
      expect(contentTermPlaces(text).map(([term]) => term), JSON.stringify(text)).toEqual(contentTerms(text));
    }
    expect(contentTermPlaces(`bac${kelvin}up`)).toEqual([['backup', 0]]);
  });

  it('a megabyte is one pass', () => {
    const text = 'The changelog lists maintenance fixes and a faster start for every platform.\n\n'.repeat(13_000);
    const started = process.cpuUsage();
    const places = contentTermPlaces(text);
    const spent = process.cpuUsage(started);
    expect(places.length).toBe(contentTerms(text).length);
    expect((spent.user + spent.system) / 1000).toBeLessThan(2_000);
  });
});
