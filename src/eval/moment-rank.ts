/*
 * moment-rank — ranking Decision Moments by significance within a window.
 *
 * What "significance" means is decided by the classifier
 * (classifySignificance in decision-moment.ts), not here. Each moment gets
 * one kind and that kind's score, and the tiers are ordered by three
 * questions, most serious first:
 *
 *   severity  — did a rule that vetoes, or a safety rule, fail?
 *               safety-violation 1.0
 *   change    — did this agent move away from its own baseline?
 *               cost-spike 0.9 (robust z over its recent costs),
 *               regression-alarm 0.85 (a rule's fail rate crossed its CUSUM line)
 *   rarity    — has this agent failed this way before?
 *               first-failure 0.8, novel-pattern 0.75
 *
 * then the ordinary outcomes: rule-collision 0.7, a fail 0.5, a partial
 * 0.4, no verdict 0.1, a clean pass 0.05. Change and rarity need a history
 * (at least 5 prior evaluated traces for rarity, 20 prior costs for a cost
 * spike); below that floor a moment is ranked on what it did, not on how
 * new it looks.
 *
 * This module only orders: score descending, then newest first, then
 * trace id so that equal moments have one order on every read and a page
 * boundary never moves between two requests over the same data.
 *
 * Kept pure (no storage, no clock) so the order is testable exactly.
 */

import type { DecisionMoment } from '../types/decision-moment.js';

/**
 * How many of the most recent matching traces a significance ranking reads
 * by default, and at most. The same bound the Failures view scans: bounded
 * work for local SQLite, and far enough back for a single-user install.
 * A caller can ask for a smaller window; a larger one is refused rather
 * than silently capped.
 */
export const MOMENT_RANK_WINDOW_DEFAULT = 500;
export const MOMENT_RANK_WINDOW_MAX = 500;

/** Most significant first; newest first among equals; trace id last so the order is total. */
export function compareBySignificance(a: DecisionMoment, b: DecisionMoment): number {
  if (b.significance.score !== a.significance.score) return b.significance.score - a.significance.score;
  const ta = Date.parse(a.timestamp);
  const tb = Date.parse(b.timestamp);
  if (tb !== ta) return tb - ta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A sorted copy; the input is left as it was. */
export function rankBySignificance(moments: readonly DecisionMoment[]): DecisionMoment[] {
  return [...moments].sort(compareBySignificance);
}
