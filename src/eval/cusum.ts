/*
 * Sequential change detection on the user's own stream (0.14.0).
 *
 * Drift, as the dashboard shows it, compares two windows. A CUSUM watches a
 * STREAM: per (agent, rule), each evaluation is a Bernoulli draw — the rule
 * failed (1) or passed (0) — and the statistic accumulates the evidence
 * that the fail rate has shifted from its baseline p₀ to p₁ = p₀ + δ, with
 * δ = 0.10 the shift worth a sentence. The exact Bernoulli form, not the
 * normal-approximation reference value: the increment is the
 * log-likelihood ratio — log(p₁/p₀) on a fail, log((1−p₁)/(1−p₀)) on a
 * pass — and S_t = max(0, S_{t−1} + LLR_t), an alarm when S_t > h.
 *
 * THE BASELINE IS SET BY PRECISION, NOT BY COUNT. p̂₀ is
 * Jeffreys-smoothed, (fails + ½) / (n + 1), over the previous evaluations
 * until at least ten fails are expected (n ≥ 10 / p̂₀) AND its standard
 * error is at most a quarter of δ (2.5 points): thirty evaluations at a 5%
 * rate hold one and a half fails, fifty at 20% leave a baseline that could
 * be off by more than the shift it is watching for, and an alarm rate
 * dominated by baseline error is not drift detection. At 20% that is 256
 * evaluations; at 50%, 400. A stream that never gets there is never
 * monitored, and that is the honest outcome.
 *
 * h IS DERIVED, NEVER TYPED, AND THE BUDGET IS PER AGENT. An agent runs
 * many rules, and each rule is its own stream; a line set so that EACH
 * stream false-alarms once per 500 evaluations lets an agent with 25 rules
 * false-alarm about once per 20. So the target is per agent: about one
 * false alarm per 500 of its evaluations, however many streams it has.
 * Two corrections get there, both found by seeded simulation when first
 * needed and memoised:
 *
 *   1. Baseline error. p̂₀ is an estimate; a baseline that came out low
 *      makes an in-control stream look like drift. The per-stream line is
 *      the one at which the false-alarm rate AVERAGED over the baseline's
 *      posterior, Beta(fails + ½, n − fails + ½), is one per 500.
 *   2. Many streams. With m streams watched for the agent, each line rises
 *      by log(m) / θ, where θ is how fast that averaged rate falls with h,
 *      so each stream's rate is divided by m and their sum — a Bonferroni
 *      bound — stays at one per 500. m counts one stream per rule, doubled
 *      when the log carries runs (every evaluation then feeds a run stream
 *      too).
 *
 * A unit test reproduces 25 in-control rules at fail rates from 2% to 30%
 * and holds the per-agent false-alarm rate to the target.
 *
 * It REPORTS and never gates; it resets on alarm and re-baselines; any
 * threshold move stays a human's. Stratified by agent, and by run when the
 * stream carries one, so "the agent got worse" and "the traffic mix changed"
 * are different rows. This is the "self-calibrating eval" made honest: it
 * detects, it does not adjust.
 */
import { beta, fnv1a, mulberry32 } from './stats.js';

/** The shift in fail rate worth a sentence. */
export const CUSUM_DELTA = 0.1;

/** The in-control average run length, per AGENT across all its streams, the lines are derived for. */
export const CUSUM_TARGET_ARL0 = 500;

/** The baseline is set once this many fails are EXPECTED under p̂₀ (n ≥ 10 / p̂₀). */
export const CUSUM_MIN_EXPECTED_FAILS = 10;

/** p₁ is capped below one so the pass increment stays finite. */
const P1_CEILING = 0.999;

/** Log-likelihood ratio of one observation under p₁ against p₀. */
export function llr(failed: boolean, p0: number, p1: number): number {
  return failed ? Math.log(p1 / p0) : Math.log((1 - p1) / (1 - p0));
}

/** p₁ for a baseline p₀: the shift, capped below one. */
export function shiftedRate(p0: number, delta: number = CUSUM_DELTA): number {
  return Math.min(P1_CEILING, p0 + delta);
}

/** The Jeffreys-smoothed baseline fail rate. */
export function jeffreysRate(fails: number, n: number): number {
  return (fails + 0.5) / (n + 1);
}

/**
 * The baseline's standard error must be at most this share of δ before the
 * stream is watched. A baseline whose own error is comparable to the shift
 * it is meant to detect cannot tell drift from its own noise: at a quarter
 * of δ, a true rate half a shift above the estimate is a two-standard-error
 * event.
 */
export const CUSUM_BASELINE_SE_FRACTION = 0.25;

/**
 * Whether a baseline of n evaluations with this many fails is settled: at
 * least CUSUM_MIN_EXPECTED_FAILS fails expected under the smoothed rate, and
 * a standard error, √(p̂₀(1 − p̂₀)/n), of at most CUSUM_BASELINE_SE_FRACTION · δ.
 */
export function baselineSettled(fails: number, n: number, delta: number = CUSUM_DELTA): boolean {
  if (n === 0) return false;
  const p = jeffreysRate(fails, n);
  if (n * p < CUSUM_MIN_EXPECTED_FAILS) return false;
  return Math.sqrt((p * (1 - p)) / n) <= delta * CUSUM_BASELINE_SE_FRACTION;
}

/**
 * The in-control average run length of the Bernoulli CUSUM at (p₀, δ, h),
 * estimated by simulation: `streams` independent in-control streams, each
 * run until its first alarm or `cap` observations (a censored run counts as
 * `cap`, which biases the estimate low and h high — the safe side).
 */
export function simulateArl0(p0: number, delta: number, h: number, seed: number, streams: number = 100, cap: number = CUSUM_TARGET_ARL0 * 8): number {
  const p1 = shiftedRate(p0, delta);
  const up = llr(true, p0, p1);
  const down = llr(false, p0, p1);
  const rng = mulberry32(seed);
  let total = 0;
  for (let s = 0; s < streams; s += 1) {
    let stat = 0;
    let t = 0;
    for (; t < cap; t += 1) {
      stat = Math.max(0, stat + (rng() < p0 ? up : down));
      if (stat > h) {
        t += 1;
        break;
      }
    }
    total += t;
  }
  return total / streams;
}

const H_MEMO = new Map<string, number>();

/**
 * The alarm line h for a baseline p₀: the h at which ARL₀ ≈ CUSUM_TARGET_ARL0,
 * found by bisection over a seeded simulation. Memoised by p₀ to three
 * decimals; deterministic on every machine because the seed is a function
 * of p₀ and δ, never the clock.
 */
export function cusumThreshold(p0: number, delta: number = CUSUM_DELTA, targetArl0: number = CUSUM_TARGET_ARL0): number {
  const key = `${p0.toFixed(3)}:${delta}:${targetArl0}`;
  const hit = H_MEMO.get(key);
  if (hit !== undefined) return hit;
  const seed = fnv1a(`cusum:${key}`);
  let lo = 0.25;
  let hi = 12;
  for (let i = 0; i < 16; i += 1) {
    const mid = (lo + hi) / 2;
    const arl = simulateArl0(p0, delta, mid, seed, 100, targetArl0 * 8);
    if (arl < targetArl0) lo = mid;
    else hi = mid;
  }
  const h = (lo + hi) / 2;
  H_MEMO.set(key, h);
  return h;
}

/**
 * The in-control false-alarm rate, per observation, of a CUSUM whose p₀ was
 * ESTIMATED from a baseline of `n` evaluations with `fails` fails. Each
 * simulated stream draws its true rate from the baseline's Jeffreys
 * posterior, Beta(fails + ½, n − fails + ½), while the statistic uses the
 * point estimate p̂₀ — what happens in use, where a baseline that came out
 * low makes an in-control stream look like drift. Streams run a fixed
 * length and reset on alarm, so alarms / observations is the per-stream
 * rate averaged over the estimation error.
 */
export function simulateEstimatedRate(fails: number, n: number, delta: number, h: number, seed: number, streams: number = 100, length: number = CUSUM_TARGET_ARL0 * 8): number {
  const p0 = jeffreysRate(fails, n);
  const p1 = shiftedRate(p0, delta);
  const up = llr(true, p0, p1);
  const down = llr(false, p0, p1);
  const rng = mulberry32(seed);
  let alarms = 0;
  for (let s = 0; s < streams; s += 1) {
    const p = beta(fails + 0.5, n - fails + 0.5, rng);
    let stat = 0;
    for (let t = 0; t < length; t += 1) {
      stat = Math.max(0, stat + (rng() < p ? up : down));
      if (stat > h) {
        alarms += 1;
        stat = 0;
      }
    }
  }
  return alarms / (streams * length);
}

const H_EST_MEMO = new Map<string, number>();

/**
 * The alarm line for a baseline of `fails` in `n`, allowing for the error in
 * the baseline: the h at which the false-alarm rate AVERAGED over what the
 * true rate could be, given that baseline, is 1 / targetArl0. Found by
 * bisection over a seeded simulation and memoised; deterministic on every
 * machine. Higher than cusumThreshold(p̂₀), which assumes p̂₀ is exact.
 */
export function estimatedBaselineThreshold(fails: number, n: number, delta: number = CUSUM_DELTA, targetArl0: number = CUSUM_TARGET_ARL0): number {
  const key = `${fails}:${n}:${delta}:${targetArl0}`;
  const hit = H_EST_MEMO.get(key);
  if (hit !== undefined) return hit;
  const seed = fnv1a(`cusum-est:${key}`);
  let lo = 0.25;
  let hi = 16;
  for (let i = 0; i < 16; i += 1) {
    const mid = (lo + hi) / 2;
    if (simulateEstimatedRate(fails, n, delta, mid, seed) > 1 / targetArl0) lo = mid;
    else hi = mid;
  }
  const h = (lo + hi) / 2;
  H_EST_MEMO.set(key, h);
  return h;
}

const SLOPE_MEMO = new Map<string, number>();

/**
 * How fast the estimated-baseline alarm rate falls as h rises: θ in
 * rate ∝ e^(−θ·h). For a CUSUM on the exact p₀ this is one (the
 * log-likelihood-ratio result); when the true rate may sit above the
 * estimate it is less, because those streams drift toward the line. Read
 * off two simulated rates, at the ARL₀ line and 1.5 above it, clamped to
 * [0.2, 1] so a noisy estimate can neither undo the correction nor push h
 * past any use.
 */
export function alarmRateSlope(fails: number, n: number, delta: number = CUSUM_DELTA): number {
  const key = `${fails}:${n}:${delta}`;
  const hit = SLOPE_MEMO.get(key);
  if (hit !== undefined) return hit;
  const h1 = estimatedBaselineThreshold(fails, n, delta);
  const step = 1.5;
  const seed = fnv1a(`cusum-slope:${key}`);
  const r1 = simulateEstimatedRate(fails, n, delta, h1, seed, 200, CUSUM_TARGET_ARL0 * 8);
  const r2 = simulateEstimatedRate(fails, n, delta, h1 + step, seed, 200, CUSUM_TARGET_ARL0 * 24);
  const theta = r1 > 0 && r2 > 0 ? Math.min(1, Math.max(0.2, Math.log(r1 / r2) / step)) : 1;
  SLOPE_MEMO.set(key, theta);
  return theta;
}

/**
 * The line one stream alarms at when `streams` streams are watched for the
 * same agent at once — the per-agent false-alarm control. Each stream starts
 * from its estimated-baseline line (one false alarm per CUSUM_TARGET_ARL0
 * observations, allowing for baseline error) and adds log(streams) / θ,
 * which divides that stream's alarm rate by `streams`. Summed over every
 * stream the agent has (a Bonferroni bound), the agent raises about one
 * false alarm per CUSUM_TARGET_ARL0 evaluations, however many rules it runs.
 */
export function familyThreshold(fails: number, n: number, streams: number, delta: number = CUSUM_DELTA): number {
  const h = estimatedBaselineThreshold(fails, n, delta);
  const m = Math.max(1, streams);
  return m === 1 ? h : h + Math.log(m) / alarmRateSlope(fails, n, delta);
}

export interface StreamObservation {
  /** The evaluation's trace. */
  traceId: string;
  /** True when the rule failed on this evaluation. */
  failed: boolean;
}

export interface RegressionAlarm {
  rule: string;
  /** The trace whose evaluation crossed the line. */
  traceId: string;
  /** The run the stream was stratified by; null for the agent-wide stream. */
  run: string | null;
  /** The baseline fail rate (Jeffreys-smoothed) the stream was watched against. */
  p0: number;
  /** Evaluations the baseline was set over. */
  baselineN: number;
  /** Evaluations watched since the baseline settled, this one included. */
  monitoredN: number;
  monitoredFails: number;
  /** monitoredFails / monitoredN — the rate the stream has run at since the baseline. */
  currentRate: number;
  /** The alarm line, derived for the baseline and the number of streams watched for the agent. */
  h: number;
  /** Streams watched for this agent at once — the family the false-alarm budget is shared across. */
  streams: number;
  /** The statistic at the alarm. */
  statistic: number;
}

/**
 * Watch one (agent, rule) stream in evaluation order. The baseline phase
 * accumulates until it settles; the watch phase runs the CUSUM; an alarm
 * resets the statistic and starts a new baseline from the next
 * observation. Alarms carry the stream's own numbers.
 */
export function watchStream(observations: readonly StreamObservation[], rule: string, run: string | null = null, delta: number = CUSUM_DELTA, streams: number = 1): RegressionAlarm[] {
  const alarms: RegressionAlarm[] = [];
  let baseN = 0;
  let baseFails = 0;
  let watching = false;
  let p0 = 0;
  let p1 = 0;
  let h = 0;
  let stat = 0;
  let monN = 0;
  let monFails = 0;
  for (const o of observations) {
    if (!watching) {
      baseN += 1;
      if (o.failed) baseFails += 1;
      if (baselineSettled(baseFails, baseN)) {
        p0 = jeffreysRate(baseFails, baseN);
        p1 = shiftedRate(p0, delta);
        h = familyThreshold(baseFails, baseN, streams, delta);
        watching = true;
        stat = 0;
        monN = 0;
        monFails = 0;
      }
      continue;
    }
    monN += 1;
    if (o.failed) monFails += 1;
    stat = Math.max(0, stat + llr(o.failed, p0, p1));
    if (stat > h) {
      alarms.push({ rule, traceId: o.traceId, run, p0, baselineN: baseN, monitoredN: monN, monitoredFails: monFails, currentRate: monFails / monN, h, streams, statistic: stat });
      // Reset and re-baseline from the next observation.
      watching = false;
      baseN = 0;
      baseFails = 0;
      stat = 0;
    }
  }
  return alarms;
}

/** One evaluated trace as the failure log records it, for the stream watcher. */
export interface StreamEntry {
  traceId: string;
  timestamp: string;
  /** Rules that ran on this evaluation (skips excluded); absent on a hand-built log, which is then not a stream. */
  judged?: readonly string[];
  /** Rules that failed. */
  failed: readonly string[];
  runId?: string | null;
}

/**
 * Every alarm the agent's log raises, per rule agent-wide and per (run,
 * rule) where the log carries runs, over the entries in timestamp order.
 * Entries without a `judged` list (a hand-built log) are not observations.
 */
export function regressionAlarms(log: readonly StreamEntry[], delta: number = CUSUM_DELTA): RegressionAlarm[] {
  const ordered = [...log].filter((e) => Array.isArray(e.judged)).sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.traceId < b.traceId ? -1 : 1));
  const streams = new Map<string, { rule: string; run: string | null; obs: StreamObservation[] }>();
  const push = (key: string, rule: string, run: string | null, o: StreamObservation): void => {
    let s = streams.get(key);
    if (!s) {
      s = { rule, run, obs: [] };
      streams.set(key, s);
    }
    s.obs.push(o);
  };
  for (const e of ordered) {
    const failed = new Set(e.failed);
    for (const rule of e.judged ?? []) {
      const o = { traceId: e.traceId, failed: failed.has(rule) };
      push(`agent ${rule}`, rule, null, o);
      if (e.runId) push(`run ${e.runId} ${rule}`, rule, e.runId, o);
    }
  }
  // Every stream an evaluation feeds shares the agent's false-alarm budget:
  // one per rule agent-wide, and one more per rule when the log carries runs.
  const rules = new Set([...streams.values()].map((s) => s.rule));
  const strata = ordered.some((e) => e.runId) ? 2 : 1;
  const family = rules.size * strata;
  const out: RegressionAlarm[] = [];
  for (const s of streams.values()) out.push(...watchStream(s.obs, s.rule, s.run, delta, family));
  return out;
}

/** The alarms that fired AT one trace — the ones its moment carries. */
export function regressionAlarmsAt(log: readonly StreamEntry[], traceId: string, timestamp: string, delta: number = CUSUM_DELTA): RegressionAlarm[] {
  const upTo = log.filter((e) => e.timestamp < timestamp || e.traceId === traceId);
  return regressionAlarms(upTo, delta).filter((a) => a.traceId === traceId);
}

/** The sentence a regression-alarm moment carries. */
export function describeRegressionAlarm(a: RegressionAlarm, agentName: string): string {
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  const scope = a.run === null ? `for ${agentName}` : `for ${agentName} within run "${a.run}"`;
  return (
    `The fail rate of ${a.rule} ${scope} has shifted: ${a.monitoredFails} of the last ${a.monitoredN} evaluations failed (${pct(a.currentRate)}) against a baseline of ${pct(a.p0)} set over ${a.baselineN} evaluations; ` +
    `the CUSUM crossed its line (h = ${a.h.toFixed(2)}, set so that across the ${a.streams} stream${a.streams === 1 ? '' : 's'} watched for this agent a false alarm comes about once per ${CUSUM_TARGET_ARL0} evaluations, allowing for the error in the baseline) at this trace. ` +
    'This reports and never gates: the watcher resets here and re-baselines from the next evaluation; any threshold move is yours.'
  );
}
