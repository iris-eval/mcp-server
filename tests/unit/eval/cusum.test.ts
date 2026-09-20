/*
 * The Bernoulli CUSUM (arc 7, D-7b; plan §4.15).
 *
 * h is derived, never typed: the line for a baseline p₀ is the one at which
 * the in-control average run length is about 500, found by a seeded
 * simulation. This file re-derives that run length on a DIFFERENT seed and
 * holds it to the target; sees an alarm within the expected run length
 * after a ten-point shift; checks the baseline is set by expected fails,
 * not by count; and checks the reset and re-baseline after an alarm.
 */
import { describe, expect, it } from 'vitest';
import {
  CUSUM_DELTA,
  CUSUM_MIN_EXPECTED_FAILS,
  CUSUM_TARGET_ARL0,
  baselineSettled,
  cusumThreshold,
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

  it('the baseline is set by expected fails, not by count: thirty evaluations at 5% are not enough, fifty at 20% are', () => {
    expect(jeffreysRate(0, 0)).toBe(0.5);
    expect(baselineSettled(1, 30)).toBe(false); // 30 · (1.5 / 31) ≈ 1.45 expected fails
    expect(baselineSettled(10, 50)).toBe(true); // 50 · (10.5 / 51) ≈ 10.3
    expect(baselineSettled(9, 50)).toBe(false); // 50 · (9.5 / 51) ≈ 9.3
    expect(CUSUM_MIN_EXPECTED_FAILS).toBe(10);
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

    // A shift: 200 draws at 20% (the baseline settles at 50), then 30% for
    // the rest. The expected run length after a δ = 0.10 shift at this h is
    // tens of evaluations; hold the first alarm to within 300 of the shift.
    const before = draws(200, 0.2, 'shift:before');
    const after = draws(1_500, 0.3, 'shift:after');
    const obs = [...before, ...after].map((failed, i) => ({ traceId: `t${i}`, failed }));
    const alarms = watchStream(obs, 'no_pii');
    const firstAfterShift = alarms.find((a) => Number(a.traceId.slice(1)) >= 200);
    expect(firstAfterShift, 'an alarm after the shift').toBeDefined();
    expect(Number(firstAfterShift!.traceId.slice(1)) - 200).toBeLessThan(300);
    expect(firstAfterShift!.currentRate).toBeGreaterThan(firstAfterShift!.p0);
    expect(firstAfterShift!.rule).toBe('no_pii');
    expect(firstAfterShift!.h).toBe(cusumThreshold(firstAfterShift!.p0));
  }, 120_000);

  it('never alarms before the baseline settles, and resets and re-baselines after an alarm', () => {
    // Twelve fails in a row on a fresh stream: the baseline settles at the
    // tenth or so (p̂₀ near one), and nothing is an alarm during the baseline.
    const allFails = Array.from({ length: 12 }, (_, i) => ({ traceId: `f${i}`, failed: true }));
    expect(watchStream(allFails, 'r')).toEqual([]);
    // A settled 20% baseline, then a run of fails: the first alarm resets the
    // watcher, so a second run of fails cannot alarm until a NEW baseline
    // settles — the alarms are separated by at least a baseline's worth.
    const base = draws(200, 0.2, 'reset:base').map((failed, i) => ({ traceId: `b${i}`, failed }));
    const fails = Array.from({ length: 400 }, (_, i) => ({ traceId: `x${i}`, failed: true }));
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
    // 300 traces: no_pii fails at 20% throughout for run A; run B is clean for
    // 150 traces then fails every time — the run-B stream alarms, the
    // agent-wide stream may or may not, and the alarm names the run.
    const rng = mulberry32(fnv1a('strata'));
    const log: StreamEntry[] = [];
    for (let i = 0; i < 300; i += 1) log.push(entry(i, rng() < 0.2 ? ['no_pii'] : [], undefined, 'A'));
    for (let i = 300; i < 450; i += 1) log.push(entry(i, rng() < 0.2 ? ['no_pii'] : [], undefined, 'B'));
    for (let i = 450; i < 600; i += 1) log.push(entry(i, ['no_pii'], undefined, 'B'));
    const alarms = regressionAlarms(log);
    const onB = alarms.filter((a) => a.run === 'B' && a.rule === 'no_pii');
    expect(onB.length).toBeGreaterThan(0);
    expect(Number(onB[0].traceId.slice(1))).toBeGreaterThanOrEqual(450);
    expect(alarms.some((a) => a.rule === 'min_output_length')).toBe(false);
    // Entries without a judged list are not observations.
    expect(regressionAlarms(log.map((e) => ({ ...e, judged: undefined })))).toEqual([]);
  }, 60_000);

  it('regressionAlarmsAt reads the log up to and including the trace, and returns only the alarms raised at it', () => {
    const rng = mulberry32(fnv1a('at'));
    const log: StreamEntry[] = [];
    for (let i = 0; i < 200; i += 1) log.push(entry(i, rng() < 0.2 ? ['no_pii'] : []));
    for (let i = 200; i < 400; i += 1) log.push(entry(i, ['no_pii']));
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
