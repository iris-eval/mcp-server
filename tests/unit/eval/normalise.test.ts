/*
 * The shared normalisation pass (arc 3, A3-2; acceptance row V2).
 *
 * Three properties matter and each is tested here rather than through a
 * rule: ASCII text is untouched (so no existing verdict can move), every
 * evasion the transforms table measures is folded, and a span in normalised
 * coordinates maps back onto the RAW text — which is what keeps arc 1's
 * evidence contract true after the fold.
 */
import { describe, expect, it } from 'vitest';
import { normalise, toRawSpan } from '../../../src/eval/text/normalise.js';

const raw = (s: string, a: number, b: number): string => s.slice(a, b);

describe('normalise — leaves ordinary text alone', () => {
  it('returns plain ASCII unchanged, with an identity map', () => {
    const s = 'The customer SSN is 536-22-8145 and the order shipped.';
    const n = normalise(s);
    expect(n.text).toBe(s);
    expect(n.unchanged).toBe(true);
    for (let i = 0; i < s.length; i++) expect(n.map[i]).toBe(i);
    expect(n.map[s.length]).toBe(s.length);
  });

  it('is idempotent', () => {
    const s = 'Ｐａｓｓword​ with  spaces\tand а Cyrillic а.';
    const once = normalise(s).text;
    expect(normalise(once).text).toBe(once);
  });

  it('collapses a whitespace run to one space and keeps single spaces as they were', () => {
    expect(normalise('a  b').text).toBe('a b');
    expect(normalise('a\t\n b').text).toBe('a\nb'); // the run broke a line, so the line survives
    expect(normalise('a b').text).toBe('a b');
    expect(normalise('a b').unchanged).toBe(true);
  });
});

describe('normalise — folds every evasion the transforms table measures', () => {
  it('drops zero-width characters, joiners and the soft hyphen', () => {
    for (const zw of ['​', '‌', '‍', '‎', '‏', '⁠', '﻿', '­']) {
      expect(normalise(`4111${zw}1111${zw}1111${zw}1111`).text).toBe('4111111111111111');
    }
  });

  it('folds full-width digits and letters through NFKC', () => {
    expect(normalise('４１１１１１１１１１１１１１１１').text).toBe('4111111111111111');
    expect(normalise('ｐａｓｓｗｏｒｄ').text).toBe('password');
  });

  it('folds mathematical alphanumerics through NFKC', () => {
    expect(normalise('𝐢𝐠𝐧𝐨𝐫𝐞').text).toBe('ignore');
  });

  it('maps the Cyrillic and Greek lookalikes NFKC leaves alone', () => {
    expect(normalise('раssword').text).toBe('password'); // Cyrillic р and а
    expect(normalise('ΡΑSSWΟRD').text).toBe('PASSWORD'); // Greek Rho, Alpha, Omicron
    expect(normalise('ѕесrеt').text).toBe('secret');
  });

  it('splices a tab or a line break out of the middle of a token', () => {
    expect(normalise('536-22\t-8145').text).toBe('536-22 -8145');
    expect(normalise('ignore all\nprevious').text).toBe('ignore all\nprevious'); // line structure is meaning
  });

  it('does NOT apply leetspeak, because that would blind every digit detector', () => {
    // 0 stays 0 and 1 stays 1: a card number must survive the shared pass.
    expect(normalise('4111 1111 1111 1111').text).toBe('4111 1111 1111 1111');
    expect(normalise('passw0rd').text).toBe('passw0rd');
  });
});

describe('normalise — spans map back onto the raw text', () => {
  it('a match on the folded text resolves to the raw characters it came from', () => {
    const s = 'card 4111​1111​1111​1111 end';
    const n = normalise(s);
    const at = n.text.indexOf('4111111111111111');
    expect(at).toBeGreaterThan(-1);
    const [a, b] = toRawSpan(n, at, at + 16);
    // The raw span covers the digits AND the zero-width characters between them.
    expect(raw(s, a, b).replace(/​/g, '')).toBe('4111111111111111');
    expect(raw(s, a, b)).toContain('​');
  });

  it('a match after a full-width run resolves to the right raw offsets', () => {
    const s = 'prefix ４１１１ and then the word secret';
    const n = normalise(s);
    const at = n.text.indexOf('secret');
    const [a, b] = toRawSpan(n, at, at + 'secret'.length);
    expect(raw(s, a, b)).toBe('secret');
  });

  it('a match spanning a collapsed whitespace run covers the whole run', () => {
    const s = 'ignore   all previous';
    const n = normalise(s);
    const at = n.text.indexOf('ignore all');
    const [a, b] = toRawSpan(n, at, at + 'ignore all'.length);
    expect(raw(s, a, b)).toBe('ignore   all');
  });

  it('the map has one entry per normalised character plus a terminator', () => {
    const n = normalise('a​b  c');
    expect(n.map.length).toBe(n.text.length + 1);
    expect(n.map[n.text.length]).toBe('a​b  c'.length);
  });

  it('offsets never run backwards', () => {
    const n = normalise('Ｐ а​ s  s\tw０rd — ﬁn');
    for (let i = 1; i < n.map.length; i++) expect(n.map[i]).toBeGreaterThanOrEqual(n.map[i - 1]);
  });
});
