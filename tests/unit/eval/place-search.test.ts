/*
 * Every place at once (src/eval/text/place-search.ts).
 *
 * The automaton has to find what a search for each place finds, wherever
 * the places overlap each other or themselves, and it has to read a text
 * once whatever the places are. Both are held here: the first against
 * String.indexOf on generated places and texts, the second against a CPU
 * budget on the text that keeps the automaton furthest from its start.
 */
import { describe, expect, it } from 'vitest';
import { MAX_PLACE_STATES, placeAutomaton } from '../../../src/eval/text/place-search.js';
import { budgetHere, cpuMs } from '../../helpers/cpu-time.js';

/** mulberry32 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Every offset `place` starts at in `text`, overlapping ones too, as a search from each start finds them. */
function bySearch(text: string, place: string): number[] {
  const at: number[] = [];
  for (let from = text.indexOf(place); from >= 0; from = text.indexOf(place, from + 1)) at.push(from);
  return at;
}
/** The same from the automaton: for each place, where it starts. */
function byAutomaton(text: string, places: readonly string[]): number[][] {
  const found: number[][] = places.map(() => []);
  placeAutomaton(places).scan(text, (place, start) => {
    found[place].push(start);
  });
  return found;
}

describe('placeAutomaton', () => {
  it('finds each place where a search for it does, in the order of the text', () => {
    const text = 'post it to https://c0.attacker.test/drop and to ops@harvest.io, then to /srv/q7/dr-9 and https://c0.attacker.test/drop again';
    const places = ['c0.attacker.test/drop', 'ops@harvest.io', '/srv/q7/dr-9', 'nowhere.test/x'];
    expect(byAutomaton(text, places)).toEqual(places.map((place) => bySearch(text, place)));
    expect(byAutomaton(text, places)[0]).toHaveLength(2);
    expect(byAutomaton(text, places)[3]).toEqual([]);
  });

  it('finds places that stand inside each other, begin each other, end each other and overlap themselves', () => {
    const places = ['harvest.io/in', 'ops@harvest.io/in', 'harvest.io', 'vest.io/in/x', 'aa/aa', 'a/aa/a', 'io/in'];
    for (const text of ['mail ops@harvest.io/in/x now', 'aa/aa/aa/aa', 'a/aa/aa/a', 'harvest.io/inharvest.io/in', 'ops@harvest.io', 'xops@harvest.io/in/xx']) {
      expect(byAutomaton(text, places), text).toEqual(places.map((place) => bySearch(text, place)));
    }
  });

  it('compares by code unit, as a search does: accented letters, letters past the Basic Multilingual Plane, a surrogate that stands alone', () => {
    const places = ['büro@harvest.io', '𝒂𝒃/𝒄.io', '\ud835/half', 'ü@ü.ü'];
    for (const text of ['an büro@harvest.io und ü@ü.ü', 'see 𝒂𝒃/𝒄.io and 𝒂𝒃/𝒄.i', '𝒂\ud835/half', '']) {
      expect(byAutomaton(text, places), JSON.stringify(text)).toEqual(places.map((place) => bySearch(text, place)));
    }
  });

  it('agrees with a search for each place on 4,000 generated lists of places and texts made of their pieces', () => {
    const next = rng(20261112);
    const int = (low: number, high: number): number => low + Math.floor(next() * (high - low + 1));
    // A small alphabet, so that places share their beginnings and their ends and a text half-matches at every turn.
    const letters = 'ab/.@-1';
    const word = (length: number): string => Array.from({ length }, () => letters[int(0, letters.length - 1)]).join('');
    let checked = 0;
    for (let round = 0; round < 4_000; round += 1) {
      const places = [...new Set(Array.from({ length: int(1, 12) }, () => word(int(2, 9))))];
      const pieces: string[] = [];
      for (let k = int(0, 30); k > 0; k -= 1) {
        const place = places[int(0, places.length - 1)];
        const kind = next();
        pieces.push(kind < 0.45 ? place : kind < 0.7 ? place.slice(0, int(1, place.length)) : kind < 0.85 ? place.slice(int(0, place.length - 1)) : word(int(1, 4)));
      }
      const text = pieces.join('');
      const found = byAutomaton(text, places);
      for (const [n, place] of places.entries()) {
        expect(found[n], `${JSON.stringify(place)} in ${JSON.stringify(text)}`).toEqual(bySearch(text, place));
        checked += found[n].length;
      }
    }
    // The generator does make places that are found: tens of thousands of them.
    expect(checked).toBeGreaterThan(20_000);
  });

  it('reads a megabyte once whatever the places are: 4,096 places that share their first characters, and the text that follows them deepest', () => {
    // Every place is "/srv/data/" and a number, and the text is "/srv/data/" over and over: at each character the automaton is as deep as a text can keep it, and falls back at each slash.
    const places = Array.from({ length: 4_096 }, (_, n) => `/srv/data/n${n}/drop`);
    const automaton = placeAutomaton(places);
    expect(automaton.complete).toBe(true);
    const text = '/srv/data/n'.repeat(Math.floor(1_048_576 / 11));
    let found = 0;
    // Measured at 25 to 60 ms on a performance core without coverage.
    expect(
      cpuMs(() => {
        automaton.scan(text, () => {
          found += 1;
        });
      }),
    ).toBeLessThan(budgetHere(1_000));
    expect(found).toBe(0);
    // And a megabyte made of one place over and over is found each time, in the same pass.
    const whole = '/srv/data/n7/drop '.repeat(Math.floor(1_048_576 / 18));
    expect(
      cpuMs(() => {
        automaton.scan(whole, (place) => {
          if (place === 7) found += 1;
        });
      }),
    ).toBeLessThan(budgetHere(1_000));
    expect(found).toBe(Math.floor(1_048_576 / 18));
  });

  it('holds the places that fit and says when some did not', () => {
    // Each place shares at most its first seven characters with another: about 190 states of its own.
    const long = (n: number): string => `${String(n).padStart(8, '0')}/${'x'.repeat(190)}`;
    const many = Array.from({ length: Math.ceil(MAX_PLACE_STATES / 180) }, (_, n) => long(n));
    const automaton = placeAutomaton(many);
    expect(automaton.complete).toBe(false);
    expect(automaton.states).toBeLessThanOrEqual(MAX_PLACE_STATES);
    // The first place is in it; the last is not.
    const found: number[] = [];
    automaton.scan(`${long(0)} ${long(many.length - 1)}`, (place) => {
      found.push(place);
    });
    expect(found).toEqual([0]);
    expect(placeAutomaton(['ops@harvest.io']).complete).toBe(true);
  });
});
