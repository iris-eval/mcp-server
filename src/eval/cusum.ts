/*
 * Sequential change detection on the user's own stream (arc 7, D-7b; plan
 * §4.15).
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
 * THE BASELINE IS SET BY EXPECTED FAILS, NOT BY COUNT. p̂₀ is
 * Jeffreys-smoothed, (fails + ½) / (n + 1), over the previous evaluations
 * until at least ten fails are expected (n ≥ 10 / p̂₀): thirty evaluations
 * at a 5% rate hold one and a half fails, and an alarm rate dominated by
 * baseline error is not drift detection. A stream that never reaches ten
 * expected fails is never monitored, and that is the honest outcome.
 *
 * h IS DERIVED, NEVER TYPED. For a given p₀ and δ, h is the line at which
 * the in-control average run length ARL₀ is about 500, found by a seeded
 * simulation at the time it is first needed and memoised; a unit test
 * re-derives it on a different seed and holds the run length to the target.
 *
 * It REPORTS and never gates; it resets on alarm and re-baselines; any
 * threshold move stays a human's. Stratified by agent, and by run when the
 * stream carries one, so "the agent got worse" and "the traffic mix changed"
 * are different rows. This is the "self-calibrating eval" made honest: it
 * detects, it does not adjust.
 */
import { fnv1a, mulberry32 } from './stats.js';

/** The shift in fail rate worth a sentence. */
export const CUSUM_DELTA = 0.1;

/** The in-control average run length h is derived for. */
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
 * Whether a baseline of n evaluations with this many fails is settled:
 * at least CUSUM_MIN_EXPECTED_FAILS fails expected under the smoothed rate.
 */
export function baselineSettled(fails: number, n: number): boolean {
  if (n === 0) return false;
  return n * jeffreysRate(fails, n) >= CUSUM_MIN_EXPECTED_FAILS;
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
  /** The alarm line, derived for p0. */
  h: number;
  /** The statistic at the alarm. */
  statistic: number;
}

/**
 * Watch one (agent, rule) stream in evaluation order. The baseline phase
 * accumulates until it settles; the watch phase runs the CUSUM; an alarm
 * resets the statistic and starts a new baseline from the next
 * observation. Alarms carry the stream's own numbers.
 */
export function watchStream(observations: readonly StreamObservation[], rule: string, run: string | null = null, delta: number = CUSUM_DELTA): RegressionAlarm[] {
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
        h = cusumThreshold(p0, delta);
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
      alarms.push({ rule, traceId: o.traceId, run, p0, baselineN: baseN, monitoredN: monN, monitoredFails: monFails, currentRate: monFails / monN, h, statistic: stat });
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
  const out: RegressionAlarm[] = [];
  for (const s of streams.values()) out.push(...watchStream(s.obs, s.rule, s.run, delta));
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
    `the CUSUM crossed its line (h = ${a.h.toFixed(2)}, derived for an in-control run length of about ${CUSUM_TARGET_ARL0}) at this trace. ` +
    'This reports and never gates: the watcher resets here and re-baselines from the next evaluation; any threshold move is yours.'
  );
}
