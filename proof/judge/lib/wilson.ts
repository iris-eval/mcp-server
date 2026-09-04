/*
 * Wilson score interval for a binomial proportion.
 *
 * Why Wilson and not the textbook ±1.96·sqrt(p(1-p)/n): the proof sets are
 * small (a few dozen cases per template) and the observed proportions sit
 * near 0 or 1, which is exactly where the normal approximation collapses
 * (it happily reports an interval of [0.97, 1.03] for 35/36). Wilson stays
 * inside [0, 1], is asymmetric where the data are, and behaves at k = 0 and
 * k = n. Reference: Wilson, E. B. (1927), J. Amer. Statist. Assoc. 22:209.
 *
 * z defaults to the two-sided 95% quantile of the standard normal.
 */

export interface WilsonInterval {
  lo: number;
  hi: number;
}

export const Z_95 = 1.959963984540054;

/**
 * Interval for k successes in n trials. Returns null when n is 0 (no data,
 * no interval). Throws on a malformed pair — a negative count or k > n is
 * a bug in the caller, not a statistical edge case.
 */
export function wilson(k: number, n: number, z: number = Z_95): WilsonInterval | null {
  if (!Number.isInteger(k) || !Number.isInteger(n)) {
    throw new TypeError(`wilson(k, n) needs integers, got k=${k} n=${n}`);
  }
  if (n < 0 || k < 0 || k > n) {
    throw new RangeError(`wilson(k, n) needs 0 <= k <= n, got k=${k} n=${n}`);
  }
  if (n === 0) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    lo: Math.max(0, centre - half),
    hi: Math.min(1, centre + half),
  };
}
