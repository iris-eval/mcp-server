/*
 * failure-rank — pure ranking logic for the failure-first landing list.
 *
 * The dashboard's default screen is a ranked list of recent failures
 * ("what's new and bad"), not an aggregate. Ranking blends two signals:
 *
 *   severity — the significance classifier's 0-1 score (safety-violation
 *              1.0 > cost-spike 0.9 > rule-collision 0.7 > normal-fail
 *              0.5/0.4). See classifySignificance in decision-moment.ts.
 *   recency  — exponential decay with a 24h half-life. A safety violation
 *              from three days ago ranks below a plain fail from an hour
 *              ago, which is the right call for a "since you last looked"
 *              surface — old severity is history, not news.
 *
 * Kept as a pure module (no storage, no clock reads — `nowMs` is a
 * parameter) so tests can pin time and assert exact orderings.
 */

import type { DecisionMoment } from '../types/decision-moment.js';

/** Recency half-life: a failure loses half its rank weight every 24h. */
export const FAILURE_RANK_HALF_LIFE_MS = 24 * 60 * 60 * 1000;

/*
 * Significance kinds that flag a moment for the failure list even when
 * its verdict is not fail/partial. A cost spike on a passing trace is
 * still something the builder should see on the landing screen.
 */
const FLAGGED_KINDS = new Set(['safety-violation', 'cost-spike']);

/**
 * Is this moment a failure (verdict fail/partial) or flagged
 * (safety/cost significance regardless of verdict)?
 */
export function isFailureMoment(moment: DecisionMoment): boolean {
  if (moment.verdict === 'fail' || moment.verdict === 'partial') return true;
  return FLAGGED_KINDS.has(moment.significance.kind);
}

/**
 * Rank score for a failure moment: significance × recency decay.
 * Higher = shown first. Future timestamps (clock skew) clamp to age 0
 * rather than inflating the score.
 */
export function rankFailureScore(moment: DecisionMoment, nowMs: number): number {
  const ageMs = Math.max(0, nowMs - new Date(moment.timestamp).getTime());
  const recency = Math.pow(0.5, ageMs / FAILURE_RANK_HALF_LIFE_MS);
  return moment.significance.score * recency;
}
