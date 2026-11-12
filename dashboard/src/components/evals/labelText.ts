/*
 * The sentences the label controls say, in one place so the
 * trace page and the tests read the same words.
 */
import type { LabelResponse, LabelStatsRow, ReevaluateResponse } from '../../api/types';

export const pct = (x: number): string => `${Math.round(x * 100)}%`;

/**
 * What a rule's labels do, as the rules page's "In force" cell has it: they
 * weigh its fires in the verdict, they show on its results while the rule
 * reports only, or they are counted and nothing reads them. One reading for
 * both pages: the trace page said "in force on this deployment" of a
 * measurement's labels, which the cell beside it called "counted".
 */
export function labelStanding(row: Pick<LabelStatsRow, 'kind' | 'entersRisk'>): 'in the risk' | 'on its results' | 'counted' {
  if (row.entersRisk) return 'in the risk';
  return row.kind === 'detection' || row.kind === 'inference' ? 'on its results' : 'counted';
}

/** After a label is written: where the rule's local precision now stands, and what reads it. */
export function labelSentence(r: Pick<LabelResponse, 'rule' | 'min'>): string {
  const rule = r.rule;
  if (!rule) return 'Label saved.';
  const standing = labelStanding(rule);
  const COUNTED = 'No verdict is weighed by the labels of this rule.';
  if (rule.local && rule.precision) {
    const precision = `${rule.rule}: ${rule.n} labels — local precision ${pct(rule.precision.point)} [${pct(rule.precision.lo)}–${pct(rule.precision.hi)}]`;
    if (standing === 'in the risk') return `${precision}, in force on this deployment and in the risk estimate.`;
    if (standing === 'on its results') return `${precision}, shown on this rule’s results. The rule reports only here, so no verdict is weighed by it.`;
    return `${precision}. ${COUNTED}`;
  }
  const more = Math.max(0, r.min - rule.n);
  const soFar = rule.precision ? `, local precision so far ${pct(rule.precision.point)}` : '';
  const counted = `${rule.rule}: ${rule.n} of ${r.min} labels${soFar}`;
  if (standing === 'in the risk') return `${counted}; ${more} more before it replaces the published number here.`;
  if (standing === 'on its results') return `${counted}; ${more} more before this rule’s results show it. The rule reports only here.`;
  return `${counted}. ${COUNTED}`;
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
