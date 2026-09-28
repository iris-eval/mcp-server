/*
 * The generated alarm-line table.
 *
 * The regression watcher's lines come from seeded simulations that took
 * about 150 ms per baseline, so a server's first Failures or Moments request
 * at 25 rules spent seconds simulating. src/eval/cusum-thresholds.generated.ts
 * holds those results for every baseline a stream can first settle at, and
 * `npm run cusum:check` regenerates all of it in CI. These tests pin that
 * the table covers exactly those baselines, that the watcher reads it, and
 * that a spread of its rows is what the simulation returns.
 */
import { describe, expect, it } from 'vitest';
import {
  CUSUM_DELTA,
  CUSUM_TARGET_ARL0,
  alarmRateSlope,
  baselineSettled,
  estimatedBaselineThreshold,
  familyThreshold,
  settlingBaselines,
  simulateAlarmRateSlope,
  simulateEstimatedBaselineThreshold,
} from '../../../src/eval/cusum.js';
import { CUSUM_THRESHOLD_TABLE } from '../../../src/eval/cusum-thresholds.generated.js';

const { lines, maxN } = CUSUM_THRESHOLD_TABLE;

describe('the generated alarm-line table', () => {
  it('was derived at the parameters the watcher runs at', () => {
    expect(CUSUM_THRESHOLD_TABLE.delta).toBe(CUSUM_DELTA);
    expect(CUSUM_THRESHOLD_TABLE.targetArl0).toBe(CUSUM_TARGET_ARL0);
  });

  it('holds exactly the baselines a stream can first settle at, up to its cap', () => {
    const expected = settlingBaselines(maxN).map(([fails, n]) => `${fails}:${n}`);
    expect(Object.keys(lines)).toEqual(expected);
  });

  it('a settling baseline is settled, and one evaluation earlier it was not', () => {
    for (const key of Object.keys(lines)) {
      const [fails, n] = key.split(':').map(Number);
      expect(baselineSettled(fails, n), key).toBe(true);
      const afterPass = fails <= n - 1 && !baselineSettled(fails, n - 1);
      const afterFail = fails >= 1 && !baselineSettled(fails - 1, n - 1);
      expect(afterPass || afterFail, key).toBe(true);
    }
  });

  it('above n = 400 only the tenth fail settles a stream', () => {
    const late = Object.keys(lines).filter((key) => Number(key.split(':')[1]) > 400);
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((key) => key.startsWith('10:'))).toBe(true);
  });

  it('the watcher reads its lines from the table', () => {
    const [key, [h, theta]] = Object.entries(lines)[0];
    const [fails, n] = key.split(':').map(Number);
    expect(estimatedBaselineThreshold(fails, n)).toBe(h);
    expect(alarmRateSlope(fails, n)).toBe(theta);
    expect(familyThreshold(fails, n, 25)).toBe(h + Math.log(25) / theta);
  });

  /*
   * Inherent work: each row is two seeded simulations, about 150 ms of CPU
   * on a laptop. Six rows took 2.1-3.7 s on CI's runners and up to 6.5 s on
   * one, past the 5 s default; three rows (the first, the middle and the
   * last, which span the table's shapes) do half that work. 20 s is three
   * times the slowest run measured with six (6.5 s).
   */
  it('a spread of rows is exactly what the simulation returns', () => {
    const keys = Object.keys(lines);
    const picks = [0, 0.5, 1].map((q) => keys[Math.round(q * (keys.length - 1))]);
    for (const key of picks) {
      const [fails, n] = key.split(':').map(Number);
      const h = simulateEstimatedBaselineThreshold(fails, n);
      expect([h, simulateAlarmRateSlope(fails, n, CUSUM_DELTA, h)], key).toEqual(lines[key]);
    }
  }, 20_000);

  it('a baseline past the cap is simulated, as before', () => {
    const n = maxN + 1;
    expect(lines[`10:${n}`]).toBeUndefined();
    expect(baselineSettled(10, n)).toBe(true);
    expect(estimatedBaselineThreshold(10, n)).toBe(simulateEstimatedBaselineThreshold(10, n));
  });

  it('another shift size is simulated, never read from a table derived at δ = 0.1', () => {
    const [key] = Object.keys(lines);
    const [fails, n] = key.split(':').map(Number);
    const h = estimatedBaselineThreshold(fails, n, 0.2);
    expect(h).toBe(simulateEstimatedBaselineThreshold(fails, n, 0.2));
    expect(h).not.toBe(lines[key][0]);
  });
});
