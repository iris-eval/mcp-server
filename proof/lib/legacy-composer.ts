import type { EvalResult } from '../../src/types/eval.js';

/*
 * The pre-0.10.0 ship decision, kept as a YARDSTICK.
 *
 * This is the arithmetic Iris used before the composer: a weighted mean
 * against a threshold, plus a veto for any critical failure. It stopped
 * being a product behaviour in 0.12.0, when `eval.composer: "legacy"` was
 * removed two minors after 0.10.0 said it would be — but it must not stop
 * being COMPUTABLE, because the claim on /proof that the composer is better
 * is a comparison against exactly this, and a baseline you can no longer
 * compute is a number nobody can check.
 *
 * It lives in `proof/` rather than `src/` for the same reason every other
 * measurement does: `proof/` is not in the npm package's `files`, and
 * shipping the old composer to every install so that a report can quote it
 * would be dead weight in the artifact. The dependency runs one way — proof
 * reads the product, never the reverse.
 *
 * It returns a BOOLEAN, not a Verdict, because a boolean is all the baseline
 * ever needed. The old function returned a full verdict whose one exclusive
 * basis (`score_below_threshold`) then had to stay in the published response
 * union as a value nothing could emit.
 */
export function legacyWouldShip(
  result: Pick<EvalResult, 'score' | 'rule_results' | 'insufficient_data' | 'critical_failures' | 'rules_evaluated'>,
  threshold: number,
): boolean {
  const evaluated = result.rules_evaluated ?? result.rule_results.filter((r) => !r.skipped).length;
  // Nothing judged: the old arithmetic reported unknown, which read as not shipped.
  if (result.insufficient_data || evaluated === 0) return false;
  if ((result.critical_failures ?? []).length > 0) return false;
  return result.score >= threshold;
}
