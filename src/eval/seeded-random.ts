/*
 * Deterministic pseudo-randomness, for the credible interval on a verdict.
 *
 * The risk estimate draws each detector's sensitivity and specificity from
 * a Beta posterior two thousand times to put an interval on p_bad. Those
 * draws must be the same on every machine and every run, or the same
 * evaluation would carry a different interval each time it was asked and
 * the number would be unciteable. So: a fixed seed derived from the corpus
 * version and the rules that spoke, and a generator that uses only integer
 * operations and one divide.
 *
 * The proof harness has had the same two functions since the corpus
 * shipped (`proof/lib/materialise.ts`), which is why they are written here
 * rather than imported: the package ships `dist/` only, and a runtime read
 * of anything under `proof/` finds nothing in an installed copy.
 */

/** FNV-1a, 32-bit: a string to a seed. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: small, fast, deterministic across engines (integer ops + one divide). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
