/*
 * longestCycle in one pass, held to the scan it replaces.
 *
 * The search for a repeated sequence asked, for each period, from every
 * start: slice a k-gram, check it repeats nothing shorter, extend it. That
 * is n × k work for one period and grew with the cube of the run over every
 * period a run can hold, which is what held the rules that read tool calls
 * to a run's first 500 (#1013). A bound on that work then stopped the
 * search short in a longer run, and a 160-call sequence run three times
 * passed once other calls followed it.
 *
 * The pass that replaces it is n work for a period, so every period is
 * searched at every length. This file holds its answers to the earlier
 * scan's on generated sequences, and holds its cost.
 */
import { describe, expect, it } from 'vitest';
import { internKeys, longestCycle, longestCycleIn } from '../../../src/eval/rules/trajectory.js';
import { maxCycleLength } from '../../../src/eval/rules/cost.js';
import { cpuMs } from '../../helpers/cpu-time.js';

/** The scan as it was: from every start, a k-gram that repeats nothing shorter, extended as far as it goes. */
function byEveryStart(keys: readonly string[], k: number): { start: number; repetitions: number } | null {
  if (k < 1 || keys.length < k * 2) return null;
  const hasSmallerPeriod = (gram: readonly string[]): boolean => {
    for (let p = 1; p < gram.length; p += 1) {
      if (gram.length % p !== 0) continue;
      let uniform = true;
      for (let i = p; i < gram.length && uniform; i += 1) if (gram[i] !== gram[i - p]) uniform = false;
      if (uniform) return true;
    }
    return false;
  };
  let best: { start: number; repetitions: number } | null = null;
  for (let start = 0; start + k * 2 <= keys.length; start += 1) {
    if (hasSmallerPeriod(keys.slice(start, start + k))) continue;
    let len = k;
    while (start + len < keys.length && keys[start + len] === keys[start + len - k]) len += 1;
    const repetitions = Math.floor(len / k);
    if (repetitions >= 2 && (best === null || repetitions > best.repetitions)) best = { start, repetitions };
  }
  return best;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('longestCycle — one pass a period, the same answers', () => {
  it('agrees with the scan from every start on 4,000 generated sequences, at every period', () => {
    const next = rng(9);
    const int = (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1));
    let compared = 0;
    let holding = 0;
    for (let t = 0; t < 4_000; t += 1) {
      const n = int(0, 90);
      const alphabet = [1, 2, 3, 5, 12, 60][int(0, 5)];
      let keys = Array.from({ length: n }, () => `k${int(0, alphabet - 1)}`);
      // Most of them hold a planted run: a k-gram repeated two or more times somewhere in the sequence.
      if (n >= 8 && next() < 0.6) {
        const k = int(1, Math.floor(n / 2));
        const reps = int(2, Math.max(2, Math.floor(n / k)));
        const gram = Array.from({ length: k }, () => `g${int(0, alphabet + 2)}`);
        const start = int(0, Math.max(0, n - k * reps));
        keys = [...keys.slice(0, start), ...Array.from({ length: reps }, () => gram).flat(), ...keys.slice(start + k * reps)].slice(0, 110);
      }
      const ids = internKeys(keys);
      for (let k = 1; k <= Math.floor(keys.length / 2) + 1; k += 1) {
        const want = byEveryStart(keys, k);
        expect(longestCycleIn(ids, k), `sequence ${t}, period ${k}: ${keys.join(',')}`).toEqual(want);
        compared += 1;
        if (want !== null) holding += 1;
      }
    }
    // The generator reaches both answers many times over.
    expect(compared).toBeGreaterThan(50_000);
    expect(holding).toBeGreaterThan(5_000);
  });

  it('gives the k-gram with the run, and the earliest of the runs that repeat most', () => {
    const keys = ['x', 'a', 'b', 'a', 'b', 'a', 'b', 'y', 'c', 'd', 'c', 'd', 'c', 'd'];
    expect(longestCycle(keys, 2)).toEqual({ gram: ['a', 'b'], start: 1, repetitions: 3 });
    // A run whose k-gram repeats something shorter belongs to the shorter period.
    expect(longestCycle(['a', 'a', 'a', 'a', 'a', 'a'], 2)).toBeNull();
    expect(longestCycle(['a', 'a', 'a', 'a', 'a', 'a'], 1)).toEqual({ gram: ['a'], start: 0, repetitions: 6 });
    expect(longestCycle(['a', 'b'], 2)).toBeNull();
    expect(longestCycle([], 1)).toBeNull();
  });

  it('interns each distinct key once, in the order it first appears', () => {
    expect([...internKeys(['b', 'a', 'b', 'c', 'a'])]).toEqual([0, 1, 0, 2, 1]);
  });

  it('searches every period a run of 10,000 calls can hold inside a CPU budget, whatever the run is made of', () => {
    const N = 10_000;
    const next = rng(4);
    const shapes: Array<[string, string[], number | null]> = [
      ['every call distinct', Array.from({ length: N }, (_, i) => `read_file\u0000{"path":"src/file_${i}.ts"}`), null],
      ['two calls in turn', Array.from({ length: N }, (_, i) => `get_status\u0000{"id":"build-${i % 2}"}`), 2],
      ['a 3,000-call sequence run three times, then 1,000 others', [...Array.from({ length: 9_000 }, (_, i) => `r\u0000${i % 3_000}`), ...Array.from({ length: 1_000 }, (_, i) => `o\u0000${i}`)], 3_000],
      ['random over 40 keys', Array.from({ length: N }, () => `k\u0000${Math.floor(next() * 40)}`), null],
    ];
    for (const [label, keys, period] of shapes) {
      let found: number | null = null;
      // Measured at 60 to 80 ms; the scan from every start took minutes at this length.
      expect(
        cpuMs(() => {
          const ids = internKeys(keys);
          for (let k = 2; k <= maxCycleLength(N); k += 1) {
            const cycle = longestCycleIn(ids, k);
            if (cycle !== null && cycle.repetitions > 2 && found === null) found = k;
          }
        }),
        label,
      ).toBeLessThan(3_000);
      expect(found, label).toBe(period);
    }
  });
});
