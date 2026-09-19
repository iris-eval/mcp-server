/*
 * The vocabulary a comparison is read in (arc 7, D-5): what each method
 * means, what "worse" and "not distinguishable" mean, and how the numbers
 * print. Pure; the view renders it and the tests hold the table.
 */
import type { CompareRunsResult } from '../../api/types';

export const METHOD_TEXT: Record<CompareRunsResult['method'], string> = {
  'paired-mcnemar':
    'Paired: the runs share case keys, so each case is compared with itself. McNemar’s exact test on the cases that disagreed — it sees a change an unpaired test of the same size would miss.',
  'unpaired-newcombe':
    'Unpaired: the runs do not share case keys, so their pass rates are compared as two independent samples with a Newcombe interval on the difference.',
  none: 'No comparison was made: the runs are not comparable, or one of them has no evaluations.',
};

export const VERDICT_TEXT = {
  worse: 'Worse: the interval on the difference excludes zero in the direction of more failures.',
  better: 'Better: the interval on the difference excludes zero in the direction of fewer failures.',
  same: 'Not distinguishable: the interval on the difference includes zero. The smallest change these runs could have seen is stated beside it.',
  incomparable:
    'Not compared: the runs measure different things (ruleset, configuration, engine minor or agent). Force the comparison to see the numbers anyway — the reasons stay listed.',
} as const;

export type ComparisonVerdict = keyof typeof VERDICT_TEXT;

export function comparisonVerdict(c: Pick<CompareRunsResult, 'comparable' | 'forced' | 'worse' | 'better' | 'method'>): ComparisonVerdict {
  if (!c.comparable && !c.forced) return 'incomparable';
  if (c.worse) return 'worse';
  if (c.better) return 'better';
  return 'same';
}

export function fmtRate(rate: number | null, interval: { lo: number; hi: number } | null): string {
  if (rate === null) return 'no evaluations';
  const pct = `${(rate * 100).toFixed(1)}%`;
  return interval ? `${pct} [${(interval.lo * 100).toFixed(1)}%, ${(interval.hi * 100).toFixed(1)}%]` : pct;
}

export function fmtDifference(d: CompareRunsResult['difference']): string {
  if (!d) return '—';
  const sign = d.delta > 0 ? '+' : '';
  return `${sign}${(d.delta * 100).toFixed(1)} pts [${(d.lo * 100).toFixed(1)}, ${(d.hi * 100).toFixed(1)}]`;
}

export function fmtP(p: number): string {
  if (p < 0.001) return 'p < 0.001';
  return `p = ${p.toFixed(3)}`;
}

export function fmtSmallestDetectable(s: number | null): string {
  if (s === null) return '—';
  return `${(s * 100).toFixed(1)} pts`;
}

export function fmtQ(q: number | null): string {
  if (q === null) return '—';
  if (q < 0.001) return 'q < 0.001';
  return `q = ${q.toFixed(3)}`;
}

/** The per-rule statistics, in one sentence a reader can act on (D-6b). */
export const PER_RULE_TEXT =
  'Each rule is tested one-sided for a fall in its pass rate — McNemar exact on its own discordant pairs when the runs pair, else the z from its Newcombe difference — and the p-values are corrected together (Benjamini–Hochberg) so twenty rules do not manufacture a regression. Read q: a rule is marked worse only at q ≤ 0.05.';

export const EQUIVALENCE_TEXT = {
  holds:
    'Equivalent within the margin: the 90% interval on the difference lies inside ±δ — two one-sided tests at α = 0.05. A positive finding, distinct from "not distinguishable".',
  fails:
    'Not equivalent within the margin: the 90% interval on the difference reaches outside ±δ. The runs may still be indistinguishable — that is a different statement.',
} as const;

export function fmtEquivalence(e: CompareRunsResult['equivalent_within']): string {
  if (!e) return '—';
  return `${e.holds ? 'equivalent' : 'not equivalent'} within ±${(e.margin * 100).toFixed(1)} pts`;
}
