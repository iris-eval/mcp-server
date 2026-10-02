/*
 * The vocabulary a comparison is read in: what each method
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
  worse: 'Worse: a one-sided test at 5% finds more failures after than chance explains. The interval beside it is the one that test reads, and it excludes no change.',
  better: 'Better: a one-sided test at 5% finds fewer failures after than chance explains, and the second run was judged on no less than the first.',
  withheld:
    'Not called better: more cases passed than chance explains, and the second run was judged on less. A rule that did not run cannot fail, so passing more under fewer checks cannot be told from failing less.',
  equivalent: 'Equivalent within the margin you supplied: the 90% interval on the difference lies inside it, no critical rule fires on new cases, and both runs were judged on the same things.',
  same: 'Not distinguishable: the test finds no change in either direction. The smallest change these runs would have detected four times in five is stated beside it.',
  incomparable:
    'Not compared: the runs measure different things (ruleset, configuration, engine minor or agent). Force the comparison to see the numbers anyway — the reasons stay listed.',
} as const;

export type ComparisonVerdict = keyof typeof VERDICT_TEXT;

export function comparisonVerdict(c: Pick<CompareRunsResult, 'comparable' | 'forced' | 'worse' | 'better' | 'method'> & Partial<Pick<CompareRunsResult, 'call' | 'improvement_withheld'>>): ComparisonVerdict {
  if (!c.comparable && !c.forced) return 'incomparable';
  if (c.worse) return 'worse';
  if (c.better) return 'better';
  if (c.improvement_withheld) return 'withheld';
  if (c.call === 'equivalent') return 'equivalent';
  return 'same';
}

export function fmtRate(rate: number | null, interval: { lo: number; hi: number } | null): string {
  if (rate === null) return 'no evaluations';
  const pct = `${(rate * 100).toFixed(1)}%`;
  return interval ? `${pct} [${(interval.lo * 100).toFixed(1)}%, ${(interval.hi * 100).toFixed(1)}%]` : pct;
}

/** The difference in points. Unpaired it carries its interval; paired, the interval shown is on the share of changed cases that fell (fmtFell), so only the point is printed here. */
export function fmtDifference(d: CompareRunsResult['difference'], paired = false): string {
  if (!d) return '—';
  const sign = d.delta > 0 ? '+' : '';
  const point = `${sign}${(d.delta * 100).toFixed(1)} pts`;
  return paired ? point : `${point} [${(d.lo * 100).toFixed(1)}, ${(d.hi * 100).toFixed(1)}]`;
}

/** Of the pairs that changed, how many fell, with the exact interval the test reads. */
export function fmtFell(p: NonNullable<CompareRunsResult['paired']>): string {
  if (!p.fell) return 'no case changed';
  return `${p.b} of ${p.b + p.c} changed cases fell [${(p.fell.lo * 100).toFixed(1)}%, ${(p.fell.hi * 100).toFixed(1)}%]`;
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

/** A rule's failures as a count of the cases it ran on: "3 of 20", or "not run" when it ran on none. */
export function fmtFailedOfJudged(failed: number, judged: number | undefined): string {
  if (judged === undefined) return String(failed);
  return judged === 0 ? 'not run' : `${failed} of ${judged}`;
}

/** The per-rule statistics, in one sentence a reader can act on. */
export const PER_RULE_TEXT =
  'Each rule is compared only over the cases it ran on, and tested one-sided for a fall in its pass rate — McNemar exact on its own discordant pairs when the runs pair, else its Newcombe interval inverted — and the p-values are corrected together (Benjamini–Hochberg) so twenty rules do not manufacture a regression. Read q: a rule is marked worse only at q ≤ 0.05. A rule that ran in only one of the runs has no test: that is a change in what was checked.';

export const COVERAGE_TEXT =
  'Rules that ran on fewer cases in the second run than in the first. A rule that did not run on a case is neither a pass nor a failure there, so a run judged on less passes more cases without failing less. No improvement is declared while this list has entries.';

export const CRITICAL_TEXT =
  'Critical rules that fire on more cases after than before. Counted, not tested for significance: each new one is an output that must not ship, whatever the pass rate did.';

export const EQUIVALENCE_TEXT = {
  holds:
    'The 90% interval on the difference lies inside ±δ, the margin you supplied — two one-sided tests at α = 0.05. A positive finding, distinct from "not distinguishable".',
  fails:
    'Not equivalent within the margin you supplied: the 90% interval on the difference reaches outside ±δ. The runs may still be indistinguishable — that is a different statement.',
} as const;

export function fmtEquivalence(e: CompareRunsResult['equivalent_within']): string {
  if (!e) return '—';
  return `${e.holds ? 'interval inside' : 'interval reaches outside'} ±${(e.margin * 100).toFixed(1)} pts`;
}
