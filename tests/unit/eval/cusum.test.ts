/*
 * The Bernoulli CUSUM.
 *
 * h is derived, never typed. This file re-derives the known-p₀ run length
 * on a DIFFERENT seed and holds it to the target; sees an alarm within the
 * expected run length after a ten-point shift; checks the baseline is set by
 * precision, not by count; checks the reset and re-baseline after an alarm;
 * and reproduces an agent with 25 in-control rules to hold the PER-AGENT
 * false-alarm rate to one per CUSUM_TARGET_ARL0 evaluations.
 */
import { describe, expect, it } from 'vitest';
import {
  CUSUM_BASELINE_SE_FRACTION,
  CUSUM_DELTA,
  CUSUM_MIN_EXPECTED_FAILS,
  CUSUM_TARGET_ARL0,
  baselineSettled,
  cusumThreshold,
  estimatedBaselineThreshold,
  familyThreshold,
  jeffreysRate,
  llr,
  regressionAlarms,
  regressionAlarmsAt,
  shiftedRate,
  simulateArl0,
  watchStream,
  type StreamEntry,
} from '../../../src/eval/cusum.js';
import { fnv1a, mulberry32 } from '../../../src/eval/stats.js';

describe('the increments', () => {
  it('a fail raises the statistic and a pass lowers it, by the exact Bernoulli log-likelihood ratio', () => {
    const p0 = 0.2;
    const p1 = shiftedRate(p0);
    expect(p1).toBeCloseTo(0.3, 9);
    expect(llr(true, p0, p1)).toBeCloseTo(Math.log(0.3 / 0.2), 9);
    expect(llr(false, p0, p1)).toBeCloseTo(Math.log(0.7 / 0.8), 9);
    expect(llr(true, p0, p1)).toBeGreaterThan(0);
    expect(llr(false, p0, p1)).toBeLessThan(0);
    expect(shiftedRate(0.95)).toBeLessThan(1);
  });

  it('the baseline is set by precision, not by count: ten expected fails AND a standard error within a quarter of the shift', () => {
    expect(jeffreysRate(0, 0)).toBe(0.5);
    expect(baselineSettled(1, 30)).toBe(false); // 30 · (1.5 / 31) ≈ 1.45 expected fails
    expect(baselineSettled(9, 50)).toBe(false); // 50 · (9.5 / 51) ≈ 9.3 expected fails
    // Ten expected fails at 20%, but a standard error of 5.7 points — more
    // than half the ten-point shift it is watching for.
    expect(baselineSettled(10, 50)).toBe(false);
    expect(baselineSettled(54, 270)).toBe(true); // p̂₀ ≈ 0.201, SE ≈ 2.44 points ≤ 2.5
    expect(baselineSettled(10, 200)).toBe(true); // p̂₀ ≈ 0.052, 10.5 expected fails, SE ≈ 1.6 points
    expect(CUSUM_MIN_EXPECTED_FAILS).toBe(10);
    expect(CUSUM_BASELINE_SE_FRACTION).toBe(0.25);
  });
});

describe('h is derived for ARL₀ ≈ 500 and holds on a different seed', () => {
  it('for p₀ = 0.2 the in-control run length lands near the target, and h moves with p₀', () => {
    const h = cusumThreshold(0.2);
    expect(h).toBeGreaterThan(0.5);
    expect(h).toBeLessThan(12);
    // Re-derive on a seed the threshold never used, with more streams.
    const arl = simulateArl0(0.2, CUSUM_DELTA, h, fnv1a('cusum-test:independent-seed'), 300, CUSUM_TARGET_ARL0 * 8);
    expect(arl).toBeGreaterThan(CUSUM_TARGET_ARL0 * 0.6);
    expect(arl).toBeLessThan(CUSUM_TARGET_ARL0 * 1.6);
    expect(cusumThreshold(0.05)).not.toBe(h);
    expect(cusumThreshold(0.2)).toBe(h); // memoised, deterministic
  }, 60_000);
});

/** A seeded Bernoulli stream of n draws at rate p. */
function draws(n: number, p: number, seed: string): boolean[] {
  const rng = mulberry32(fnv1a(seed));
  return Array.from({ length: n }, () => rng() < p);
}

describe('watchStream', () => {
  it('raises no alarm on 5,000 in-control draws more often than the run length allows, and an alarm within the expected run length after a ten-point shift', () => {
    // In control at 20% for the whole stream: with ARL₀ ≈ 500 the alarm
    // count over 5,000 monitored draws is about ten; hold it under twice
    // that, across ten seeds, and above zero in total (a watcher that never
    // alarms is not a watcher).
    let alarmsInControl = 0;
    for (let s = 0; s < 10; s += 1) {
      const obs = draws(5_000, 0.2, `in-control:${s}`).map((failed, i) => ({ traceId: `t${i}`, failed }));
      alarmsInControl += watchStream(obs, 'r').length;
    }
    expect(alarmsInControl).toBeGreaterThan(0);
    expect(alarmsInControl).toBeLessThan(10 * (5_000 / CUSUM_TARGET_ARL0) * 2);

    // A shift: 400 draws at 20% (the baseline settles near 260), then 30%
    // for the rest. The expected run length after a δ = 0.10 shift at this h
    // is tens of evaluations. Over ten seeds, hold the median delay under 150
    // and eight of ten under 300 — a stream that false-alarms before the
    // shift re-baselines on shifted data and legitimately detects late.
    const delays: number[] = [];
    let earliest: ReturnType<typeof watchStream>[number] | undefined;
    for (let s = 0; s < 10; s += 1) {
      const series = [...draws(400, 0.2, `shift:before:${s}`), ...draws(1_500, 0.3, `shift:after:${s}`)];
      const first = watchStream(series.map((failed, i) => ({ traceId: `t${i}`, failed })), 'no_pii').find((a) => Number(a.traceId.slice(1)) >= 400);
      const delay = first ? Number(first.traceId.slice(1)) - 400 : Infinity;
      if (first && delay < Math.min(...delays)) earliest = first;
      delays.push(delay);
    }
    delays.sort((a, b) => a - b);
    expect(delays[4], `delays ${delays.join(', ')}`).toBeLessThan(150);
    expect(delays.filter((d) => d < 300).length, `delays ${delays.join(', ')}`).toBeGreaterThanOrEqual(8);

    const firstAfterShift = earliest;
    expect(firstAfterShift, 'an alarm after the shift').toBeDefined();
    expect(firstAfterShift!.currentRate).toBeGreaterThan(firstAfterShift!.p0);
    expect(firstAfterShift!.rule).toBe('no_pii');
    expect(firstAfterShift!.streams).toBe(1);
    const fails = Math.round(firstAfterShift!.p0 * (firstAfterShift!.baselineN + 1) - 0.5);
    expect(firstAfterShift!.h).toBe(familyThreshold(fails, firstAfterShift!.baselineN, 1));
    // Allowing for baseline error raises the line above the known-p₀ one.
    expect(firstAfterShift!.h).toBeGreaterThan(cusumThreshold(firstAfterShift!.p0));
  }, 120_000);

  it('never alarms before the baseline settles, and resets and re-baselines after an alarm', () => {
    // Twelve fails in a row on a fresh stream: the baseline is still settling
    // (at p̂₀ near one its error needs about forty evaluations to fall within
    // a quarter of δ), and nothing is an alarm during the baseline.
    const allFails = Array.from({ length: 12 }, (_, i) => ({ traceId: `f${i}`, failed: true }));
    expect(watchStream(allFails, 'r')).toEqual([]);
    // A settled 20% baseline, then a run of fails: the first alarm resets the
    // watcher, so a second run of fails cannot alarm until a NEW baseline
    // settles — the alarms are separated by at least a baseline's worth.
    const base = draws(400, 0.2, 'reset:base').map((failed, i) => ({ traceId: `b${i}`, failed }));
    const fails = Array.from({ length: 2_000 }, (_, i) => ({ traceId: `x${i}`, failed: true }));
    const alarms = watchStream([...base, ...fails], 'r');
    expect(alarms.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < alarms.length; i += 1) {
      const gap = Number(alarms[i].traceId.slice(1)) - Number(alarms[i - 1].traceId.slice(1));
      expect(gap).toBeGreaterThanOrEqual(alarms[i].baselineN + 1);
    }
  });
});

describe('regressionAlarms over a log', () => {
  const entry = (i: number, failed: string[], judged: string[] = ['no_pii', 'min_output_length'], runId: string | null = null): StreamEntry => ({
    traceId: `t${String(i).padStart(4, '0')}`,
    timestamp: new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString(),
    judged,
    failed,
    runId,
  });

  it('is stratified by agent and by run: a shift confined to one run alarms on that run and names it', () => {
    // no_pii fails at 20% for 400 traces of run A; run B runs at 20% for 400
    // traces then fails every time — the run-B stream alarms, the
    // agent-wide stream may or may not, and the alarm names the run.
    const rng = mulberry32(fnv1a('strata'));
    const log: StreamEntry[] = [];
    for (let i = 0; i < 400; i += 1) log.push(entry(i, rng() < 0.2 ? ['no_pii'] : [], undefined, 'A'));
    for (let i = 400; i < 800; i += 1) log.push(entry(i, rng() < 0.2 ? ['no_pii'] : [], undefined, 'B'));
    for (let i = 800; i < 1_000; i += 1) log.push(entry(i, ['no_pii'], undefined, 'B'));
    const alarms = regressionAlarms(log);
    const onB = alarms.filter((a) => a.run === 'B' && a.rule === 'no_pii');
    expect(onB.length).toBeGreaterThan(0);
    expect(Number(onB[0].traceId.slice(1))).toBeGreaterThanOrEqual(800);
    // Two rules, and the log carries runs: four streams share the budget.
    expect(onB[0].streams).toBe(4);
    expect(alarms.some((a) => a.rule === 'min_output_length')).toBe(false);
    // Entries without a judged list are not observations.
    expect(regressionAlarms(log.map((e) => ({ ...e, judged: undefined })))).toEqual([]);
  }, 60_000);

  it('regressionAlarmsAt reads the log up to and including the trace, and returns only the alarms raised at it', () => {
    const rng = mulberry32(fnv1a('at'));
    const log: StreamEntry[] = [];
    for (let i = 0; i < 400; i += 1) log.push(entry(i, rng() < 0.2 ? ['no_pii'] : []));
    for (let i = 400; i < 700; i += 1) log.push(entry(i, ['no_pii']));
    const all = regressionAlarms(log);
    expect(all.length).toBeGreaterThan(0);
    const first = all[0];
    const at = regressionAlarmsAt(log, first.traceId, log.find((e) => e.traceId === first.traceId)!.timestamp);
    expect(at.map((a) => a.traceId)).toEqual([first.traceId]);
    // A later trace with no alarm of its own carries none, even though alarms exist before it.
    const quiet = log[Number(first.traceId.slice(1)) + 1];
    expect(regressionAlarmsAt(log, quiet.traceId, quiet.timestamp).length).toBe(all.filter((a) => a.traceId === quiet.traceId).length);
  }, 60_000);
});

describe('the false-alarm budget is per agent', () => {
  /*
   * An agent with 25 rules, every one in control, at fail rates spread from
   * 2% to 30%, over 8 agents × 4,000 evaluations (fixed seeds). Watching each
   * stream at its own one-per-500 line lets the agent as a whole false-alarm
   * many times more often; the family line holds the agent to about one per
   * CUSUM_TARGET_ARL0 evaluations, baseline error included.
   */
  const RULES = 25;
  const AGENTS = 8;
  const N = 4_000;
  const rates = Array.from({ length: RULES }, (_, i) => 0.02 + (0.28 * i) / (RULES - 1));
  const agentLog = (a: number): StreamEntry[] => {
    const rng = mulberry32(fnv1a(`per-agent:${a}`));
    const judged = rates.map((_, r) => `r${r}`);
    return Array.from({ length: N }, (_, i) => ({
      traceId: `t${String(i).padStart(5, '0')}`,
      timestamp: new Date(Date.UTC(2026, 0, 1) + i * 1_000).toISOString(),
      judged,
      failed: judged.filter((_, r) => rng() < rates[r]),
    }));
  };

  it('holds 25 in-control rules to at most one false alarm per 500 evaluations of the agent', () => {
    let family = 0;
    let perStream = 0;
    for (let a = 0; a < AGENTS; a += 1) {
      const log = agentLog(a);
      const alarms = regressionAlarms(log);
      expect(alarms.every((x) => x.streams === RULES)).toBe(true);
      family += alarms.length;
      // The same streams, each at its own one-per-500 line with no family control.
      for (let r = 0; r < RULES; r += 1) {
        const obs = log.map((e) => ({ traceId: e.traceId, failed: e.failed.includes(`r${r}`) }));
        perStream += watchStream(obs, `r${r}`, null, CUSUM_DELTA, 1).length;
      }
    }
    const evaluations = AGENTS * N;
    const budget = evaluations / CUSUM_TARGET_ARL0;
    expect(family, `${family} false alarms over ${evaluations} evaluations; the budget is ${budget}`).toBeLessThanOrEqual(budget);
    // Without the family control the same agents alarm several times over budget.
    expect(perStream).toBeGreaterThan(3 * budget);
  }, 180_000);

  it('the family line is the per-stream line raised, and rises with the number of streams', () => {
    const one = familyThreshold(10, 200, 1);
    expect(one).toBe(estimatedBaselineThreshold(10, 200));
    expect(familyThreshold(10, 200, 5)).toBeGreaterThan(one);
    expect(familyThreshold(10, 200, 25)).toBeGreaterThan(familyThreshold(10, 200, 5));
  }, 60_000);
});
