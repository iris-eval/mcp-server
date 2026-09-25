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
 *   3. in the verdict's region of p_bad (ten equal bins), the dev split
 *      holds enough evidence to test the estimate at all (MIN_BIN_N and
 *      MIN_BIN_PATTERNS below), the observed bad rate of the risk-decided
 *      verdicts there is consistent with what the estimate states (the bin's
 *      mean predicted p_bad lies inside the Wilson 95% interval of the
 *      observed rate), and that interval lies wholly on the verdict's side
 *      of τ.
 *
 * The table behind 3 is generated from the corpus (./published-calibration.ts),
 * never typed, and the test split stays held out to measure the result:
 * proof/COMPOSITE.md reports how often each label was right under the old
 * rule and this one.
 *
 * "Decisive" is relative to the deployment's τ: the same estimate can be
 * decisive at one loss ratio and marginal at another.
 */
import { PUBLISHED_CALIBRATION } from './published-calibration.js';
import { wilson } from './stats.js';

/**
 * The fewest labelled verdicts a bin needs before its observed bad rate is
 * compared with the estimate. The comparison is made at the resolution of a
 * bin, 0.1 wide; below ten verdicts one label moves the observed rate by more
 * than that width, so the test would compare the estimate with noise. Without
 * a floor, a user-set τ near either end makes "decisive" easy: the Wilson
 * interval on one or two verdicts is wide, but it can still clear a τ of 0.2
 * or 0.8.
 */
export const MIN_BIN_N = 10;

/**
 * The fewest distinct detector-firing patterns a bin needs. p_bad is a
 * function of which detectors examined the output and which of them fired,
 * so cases with the same pattern get the same estimate and are not
 * independent evidence about it; the dev split's decided verdicts take only
 * a couple of dozen distinct patterns. Counting each pattern once, fewer than
 * four could not exclude τ = 0.5 even if every one agreed (the Wilson 95%
 * upper bound on 0 of 3 is 0.56; on 0 of 4 it is 0.49), so a bin backed by
 * fewer is not tested.
 */
export const MIN_BIN_PATTERNS = 4;

export type Confidence = 'decisive' | 'marginal';

/** Why a verdict is marginal. Absent when it is decisive. */
export type MarginalReason =
  | 'interval_straddles'
  | 'setting_unmeasured'
  | 'region_unmeasured'
  | 'region_too_few'
  | 'region_miscalibrated'
  | 'region_not_backed';

export interface CalibrationBin {
  from: number;
  to: number;
  /** Risk-decided verdicts on the dev split whose p_bad fell in this bin. */
  n: number;
  /** How many of them should not have shipped. */
  bad: number;
  /** How many distinct detector-firing patterns those verdicts came from: the independent evidence in the bin. */
  patterns: number;
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

/** Whether a bin holds enough evidence for its observed rate to test the estimate. */
export function testable(bin: Pick<CalibrationBin, 'n' | 'patterns'>): boolean {
  return bin.n >= MIN_BIN_N && bin.patterns >= MIN_BIN_PATTERNS;
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
  if (!testable(bin)) return { confidence: 'marginal', reason: 'region_too_few', region };
  if (bin.meanPredicted < w.lo || bin.meanPredicted > w.hi) return { confidence: 'marginal', reason: 'region_miscalibrated', region };
  const backed = risk.pBad > tau ? w.lo > tau : w.hi < tau;
  if (!backed) return { confidence: 'marginal', reason: 'region_not_backed', region };
  return { confidence: 'decisive', region };
}
