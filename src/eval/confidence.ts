/*
 * How sure a risk verdict is entitled to sound.
 *
 * Through 0.18.0 `confidence` was "decisive" whenever the credible interval on
 * p_bad sat wholly on one side of τ. That interval carries the uncertainty
 * in each detector's published error rates, and nothing else: it cannot see
 * the error in the model that combines them. The composite corpus measures
 * that error, and at the shipped defaults it is large where most verdicts
 * land. A clean pass states p_bad ≈ 0.13 with an interval near
 * [0.11, 0.17]; the outputs it says that about were bad about a third of
 * the time on the dev split and nearly half the time on the test split. A
 * label that says "decisive" there overstates what was measured.
 *
 * So "decisive" now needs three things, and says "marginal" otherwise:
 *
 *   1. the credible interval excludes τ (the old test, unchanged);
 *   2. the verdict was computed at the setting the composite corpus measured
 *      (the same prior and prior reading, published error rates rather than
 *      a deployment's own labels) — a calibration measured at one setting
 *      says nothing about another;
 *   3. in the verdict's region of p_bad (ten equal bins), the observed bad
 *      rate of the risk-decided verdicts on the dev split is consistent with
 *      what the estimate states (the bin's mean predicted p_bad lies inside
 *      the Wilson 95% interval of the observed rate), and that interval lies
 *      wholly on the verdict's side of τ.
 *
 * The table behind 3 is generated from the corpus (./published-calibration.ts),
 * never typed, and the test split stays held out to measure the result:
 * proof/COMPOSITE.md reports how often each label was right under the old
 * rule and this one.
 */
import { PUBLISHED_CALIBRATION } from './published-calibration.js';
import { wilson } from './stats.js';

export type Confidence = 'decisive' | 'marginal';

/** Why a verdict is marginal. Absent when it is decisive. */
export type MarginalReason =
  | 'interval_straddles'
  | 'setting_unmeasured'
  | 'region_unmeasured'
  | 'region_miscalibrated'
  | 'region_not_backed';

export interface CalibrationBin {
  from: number;
  to: number;
  /** Risk-decided verdicts on the dev split whose p_bad fell in this bin. */
  n: number;
  /** How many of them should not have shipped. */
  bad: number;
  /** Mean p_bad the estimate stated for them; null when the bin is empty. */
  meanPredicted: number | null;
}

export interface CalibrationTable {
  compositeVersion: string;
  split: 'dev';
  prior: number;
  priorMode: 'per-output' | 'per-class';
  bins: readonly CalibrationBin[];
}

export interface ConfidenceCall {
  confidence: Confidence;
  reason?: MarginalReason;
  /** The measured region the call read, when it got that far. */
  region?: CalibrationBin & { observed: [number, number] };
}

export interface ConfidenceSetting {
  prior: number;
  priorMode: 'per-output' | 'per-class';
  /** True when any fired rule's precision came from the deployment's own labels rather than the published rate. */
  localLabels: boolean;
}

/** The bin a p_bad falls in — the same indexing proof/lib/intervals.ts uses to build the reliability table. */
export function binOf(pBad: number, bins: readonly CalibrationBin[]): CalibrationBin | undefined {
  if (bins.length === 0) return undefined;
  const p = Math.min(1, Math.max(0, pBad));
  return bins[Math.min(bins.length - 1, Math.floor(p * bins.length))];
}

export function verdictConfidence(
  risk: { pBad: number; lo: number; hi: number },
  tau: number,
  setting: ConfidenceSetting,
  table: CalibrationTable = PUBLISHED_CALIBRATION as CalibrationTable,
): ConfidenceCall {
  if (risk.lo <= tau && tau <= risk.hi) return { confidence: 'marginal', reason: 'interval_straddles' };
  if (setting.localLabels || setting.prior !== table.prior || setting.priorMode !== table.priorMode) {
    return { confidence: 'marginal', reason: 'setting_unmeasured' };
  }
  const bin = binOf(risk.pBad, table.bins);
  const w = bin ? wilson(bin.bad, bin.n) : null;
  if (!bin || !w || bin.meanPredicted === null) return { confidence: 'marginal', reason: 'region_unmeasured' };
  const region = { ...bin, observed: [w.lo, w.hi] as [number, number] };
  if (bin.meanPredicted < w.lo || bin.meanPredicted > w.hi) return { confidence: 'marginal', reason: 'region_miscalibrated', region };
  const backed = risk.pBad > tau ? w.lo > tau : w.hi < tau;
  if (!backed) return { confidence: 'marginal', reason: 'region_not_backed', region };
  return { confidence: 'decisive', region };
}
