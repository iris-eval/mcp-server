/*
 * Cost anomaly against the agent's OWN history (arc 7, D-7a; gap G22).
 *
 * A fixed dollar figure is a policy pretending to be a measurement: $0.10
 * is a spike for a haiku-class summariser and a rounding error for a
 * research agent, and the classifier used to flag both against the same
 * literal. The store already holds the distribution, so the question
 * becomes the one a reader actually asks — "is this trace expensive FOR
 * THIS AGENT?" — answered by a robust z-score: the trace's distance from
 * the median of the agent's recent costs, in units of the median absolute
 * deviation (scaled by 1.4826 so that on normal data it reads like a
 * standard deviation). Median and MAD rather than mean and SD because a
 * cost history is exactly the kind of series a few spikes would otherwise
 * drag the baseline towards, hiding the next one.
 *
 * `cost_under_threshold` — the explicit dollar policy a deployment sets —
 * is untouched: a policy and a measurement are different things and the
 * product carries both.
 */

/** How many of the agent's most recent prior costs form the baseline. */
export const COST_ANOMALY_WINDOW = 200;

/** The robust z above which a trace is a cost spike for its agent. */
export const COST_ANOMALY_Z = 3.5;

/**
 * The smallest baseline that makes "unusual for this agent" a claim
 * rather than "early": below this the classifier says nothing about cost,
 * as the novelty classes say nothing below their own floor.
 */
export const COST_ANOMALY_MIN_HISTORY = 20;

/** MAD → σ-equivalent for a normal series. */
const MAD_TO_SIGMA = 1.4826;

export interface CostAnomaly {
  /** The trace's cost. */
  costUsd: number;
  /** Prior costs the baseline was read from (≤ COST_ANOMALY_WINDOW). */
  n: number;
  median: number;
  /** Median absolute deviation from the median, unscaled. */
  mad: number;
  /** The scale the z was read in: 1.4826 · MAD, or the floor when the MAD is zero. */
  scale: number;
  /** True when the MAD was zero and the floor supplied the scale. */
  floored: boolean;
  /** (cost − median) / scale. Positive means dearer than usual. */
  z: number;
  /** z > COST_ANOMALY_Z. */
  anomalous: boolean;
}

function median(sorted: readonly number[]): number {
  const n = sorted.length;
  return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/**
 * The robust z of one cost against a baseline of prior costs.
 *
 * Null when the baseline is smaller than COST_ANOMALY_MIN_HISTORY, or when
 * the cost is not a finite number. A baseline whose MAD is zero — every
 * recent trace cost exactly the same — would make any deviation infinite,
 * so the scale falls back to a floor: a tenth of the median, or $0.0001
 * when the median itself is zero. The result says when the floor was used.
 */
export function costAnomaly(costUsd: number, baseline: readonly number[]): CostAnomaly | null {
  if (!Number.isFinite(costUsd)) return null;
  const costs = baseline.filter((c) => Number.isFinite(c)).slice(0, COST_ANOMALY_WINDOW);
  if (costs.length < COST_ANOMALY_MIN_HISTORY) return null;
  const sorted = [...costs].sort((a, b) => a - b);
  const med = median(sorted);
  const deviations = sorted.map((c) => Math.abs(c - med)).sort((a, b) => a - b);
  const mad = median(deviations);
  const floored = mad === 0;
  const scale = floored ? Math.max(med * 0.1, 0.0001) : mad * MAD_TO_SIGMA;
  const z = (costUsd - med) / scale;
  return { costUsd, n: costs.length, median: med, mad, scale, floored, z, anomalous: z > COST_ANOMALY_Z };
}

/** The sentence a cost-spike moment carries: the agent's own baseline, never a dollar figure typed in code. */
export function describeCostAnomaly(a: CostAnomaly): string {
  const usd = (v: number): string => `$${v.toFixed(4)}`;
  const scaleNote = a.floored
    ? `the agent's last ${a.n} traces all cost ${usd(a.median)}, so the scale is a floor of ${usd(a.scale)}`
    : `median ${usd(a.median)}, MAD ${usd(a.mad)} over its last ${a.n} traces`;
  return (
    `Trace cost (${usd(a.costUsd)}) is ${a.z.toFixed(1)} robust standard deviations above this agent's own baseline (${scaleNote}); ` +
    `the spike line is ${COST_ANOMALY_Z}. Investigate prompt size, token efficiency, or model-tier choice.`
  );
}
