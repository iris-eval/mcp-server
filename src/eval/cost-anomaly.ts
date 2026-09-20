/*
 * Cost anomaly against the agent's OWN history (arc 7, D-7a; gap G22; the
 * approved algorithm §4.8, aligned in H-5).
 *
 * A fixed dollar figure is a policy pretending to be a measurement: $0.10
 * is a spike for a haiku-class summariser and a rounding error for a
 * research agent, and the classifier used to flag both against the same
 * literal. The store already holds the distribution, so the question
 * becomes the one a reader actually asks — "is this trace expensive FOR
 * THIS AGENT?" — answered by the modified z-score of Iglewicz and Hoaglin:
 * z = 0.6745 · (x − median) / MAD, a spike at z > 3.5. Median and MAD
 * rather than mean and SD because a cost history is exactly the kind of
 * series a few spikes would otherwise drag the baseline towards, hiding
 * the next one. (0.6745 is 1 / 1.4826: the same scaling written the way
 * the reference writes it.)
 *
 * Two edges the approved section names. Fewer than twenty prior costed
 * traces is `insufficient_history`: nothing is said, which is different
 * from "fine". A MAD of zero — every recent trace cost exactly the same —
 * would make any deviation infinite, so the fallback is the section's:
 * the trace is anomalous when it exceeds EVERY prior value by more than
 * ten percent, and the result says the fallback was used.
 *
 * `cost_under_threshold` — the explicit dollar policy a deployment sets —
 * is untouched: a policy and a measurement are different things and the
 * product carries both. One implementation serves the moment classifier
 * (src/eval/decision-moment.ts) and the `cost_anomaly` rule
 * (src/eval/rules/cost.ts).
 */

/** How many of the agent's most recent prior costs form the baseline. */
export const COST_ANOMALY_WINDOW = 200;

/** The modified z above which a trace is a cost spike for its agent (Iglewicz–Hoaglin). */
export const COST_ANOMALY_Z = 3.5;

/**
 * The smallest baseline that makes "unusual for this agent" a claim
 * rather than "early": below this the classifier and the rule report
 * `insufficient_history`, as the novelty classes say nothing below their
 * own floor.
 */
export const COST_ANOMALY_MIN_HISTORY = 20;

/** With a zero MAD, a trace is anomalous when it exceeds every prior value by more than this fraction. */
export const COST_ANOMALY_FLAT_MARGIN = 0.1;

/** The Iglewicz–Hoaglin constant: 1 / 1.4826. */
const MODIFIED_Z_SCALE = 0.6745;

export interface CostAnomaly {
  /** The trace's cost. */
  costUsd: number;
  /** Prior costs the baseline was read from (≤ COST_ANOMALY_WINDOW). */
  n: number;
  median: number;
  /** Median absolute deviation from the median, unscaled. */
  mad: number;
  /** The largest prior cost — the line the flat-history fallback reads against. */
  maxPrior: number;
  /** The modified z, 0.6745 · (cost − median) / MAD; null when the MAD is zero and the fallback decided instead. */
  z: number | null;
  /** True when the MAD was zero and the fallback ("more than ten percent over every prior value") decided. */
  fallback: boolean;
  /** z > COST_ANOMALY_Z, or under the fallback cost > maxPrior · (1 + COST_ANOMALY_FLAT_MARGIN). */
  anomalous: boolean;
}

function median(sorted: readonly number[]): number {
  const n = sorted.length;
  return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/**
 * The modified z of one cost against a baseline of prior costs, newest
 * first. Null when the baseline is smaller than COST_ANOMALY_MIN_HISTORY
 * or the cost is not a finite number.
 */
export function costAnomaly(costUsd: number, baseline: readonly number[]): CostAnomaly | null {
  if (!Number.isFinite(costUsd)) return null;
  const costs = baseline.filter((c) => Number.isFinite(c)).slice(0, COST_ANOMALY_WINDOW);
  if (costs.length < COST_ANOMALY_MIN_HISTORY) return null;
  const sorted = [...costs].sort((a, b) => a - b);
  const med = median(sorted);
  const deviations = sorted.map((c) => Math.abs(c - med)).sort((a, b) => a - b);
  const mad = median(deviations);
  const maxPrior = sorted[sorted.length - 1];
  if (mad === 0) {
    return { costUsd, n: costs.length, median: med, mad, maxPrior, z: null, fallback: true, anomalous: costUsd > maxPrior * (1 + COST_ANOMALY_FLAT_MARGIN) };
  }
  const z = (MODIFIED_Z_SCALE * (costUsd - med)) / mad;
  return { costUsd, n: costs.length, median: med, mad, maxPrior, z, fallback: false, anomalous: z > COST_ANOMALY_Z };
}

/** The sentence a cost-spike moment or a fired rule carries: the agent's own baseline, never a dollar figure typed in code. */
export function describeCostAnomaly(a: CostAnomaly): string {
  const usd = (v: number): string => `$${v.toFixed(4)}`;
  if (a.fallback) {
    const over = ((a.costUsd / a.maxPrior - 1) * 100).toFixed(0);
    return (
      `Trace cost (${usd(a.costUsd)}) is ${over}% over the most this agent has cost before (${usd(a.maxPrior)}, and its last ${a.n} traces all cost about the same, so the usual spread cannot be read); ` +
      `the fallback line is ${COST_ANOMALY_FLAT_MARGIN * 100}% over every prior value. Investigate prompt size, token efficiency, or model-tier choice.`
    );
  }
  return (
    `Trace cost (${usd(a.costUsd)}) has a modified z of ${a.z!.toFixed(1)} against this agent's own baseline (median ${usd(a.median)}, MAD ${usd(a.mad)} over its last ${a.n} traces); ` +
    `the spike line is ${COST_ANOMALY_Z}. Investigate prompt size, token efficiency, or model-tier choice.`
  );
}
