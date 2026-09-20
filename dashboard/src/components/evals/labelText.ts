/*
 * The sentences the label controls say (arc 7, D-8), in one place so the
 * trace page and the tests read the same words.
 */
import type { LabelResponse, LabelStatsRow, ReevaluateResponse } from '../../api/types';

export const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** After a label is written: where the rule's local precision now stands. */
export function labelSentence(r: Pick<LabelResponse, 'rule' | 'min'>): string {
  const rule = r.rule;
  if (!rule) return 'Label saved.';
  if (rule.local && rule.precision) {
    return `${rule.rule}: ${rule.n} labels — local precision ${pct(rule.precision.point)} [${pct(rule.precision.lo)}–${pct(rule.precision.hi)}], in force on this deployment${rule.entersRisk ? ' and in the risk estimate' : ''}.`;
  }
  const more = Math.max(0, r.min - rule.n);
  const soFar = rule.precision ? `, local precision so far ${pct(rule.precision.point)}` : '';
  return `${rule.rule}: ${rule.n} of ${r.min} labels${soFar}; ${more} more before it replaces the published number here.`;
}

/** After a re-score: what changed, or that nothing did. */
export function reevaluateSentence(r: Pick<ReevaluateResponse, 'before' | 'after' | 'changed'>): string {
  const before = r.before.verdict ?? 'no verdict';
  const after = r.after.verdict ?? 'no verdict';
  return r.changed ? `Re-scored: verdict ${before} → ${after}.` : `Re-scored: verdict unchanged (${after}).`;
}

/** The local-precision cell on the rules page. */
export function localPrecisionCell(row: Pick<LabelStatsRow, 'n' | 'precision'>): string {
  if (row.n === 0 || !row.precision) return 'no labels yet';
  return `${row.precision.point.toFixed(2)} [${row.precision.lo.toFixed(2)}, ${row.precision.hi.toFixed(2)}] · n = ${row.n}`;
}
