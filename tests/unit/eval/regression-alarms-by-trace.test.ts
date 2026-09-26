/*
 * The regression alarms of every trace, in one pass (#680).
 *
 * The list routes asked regressionAlarmsAt for each trace in their window,
 * and each call re-ran every stream's watcher over the log up to that
 * trace. regressionAlarmsByTrace answers for all of them at once. These
 * tests pin what a trace's alarms depend on, and hold the one pass to
 * exactly what the per-trace call returns.
 */
import { describe, expect, it } from 'vitest';
import { regressionAlarms, regressionAlarmsAt, regressionAlarmsByTrace, type StreamEntry } from '../../../src/eval/cusum.js';
import { historyBefore } from '../../../src/eval/decision-moment.js';
import { fnv1a, mulberry32 } from '../../../src/eval/stats.js';

/*
 * Every test here runs the per-trace reference, which is the quadratic cost
 * #680 removes from the routes, so each is heavy on purpose. Measured at
 * 0.7-5.3 s alone and up to 15.8 s with 20 busy-loop processes on a
 * 20-core machine; about four times that.
 */
const HEAVY_MS = 60_000;

const ts = (i: number): string => new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString();

/**
 * A seeded agent log with the shapes that make the question hard: rules
 * that start being judged part-way through, runs that start part-way
 * through, traces that share a timestamp, entries without a judged list,
 * and a shift in one rule's fail rate so alarms fire.
 */
function hardLog(seed: string, n = 900): StreamEntry[] {
  const rng = mulberry32(fnv1a(seed));
  const rules = ['a', 'b', 'c', 'd', 'e'];
  const firstJudged: Record<string, number> = { a: 0, b: 0, c: Math.floor(n * 0.2), d: Math.floor(n * 0.8), e: 0 };
  const rate: Record<string, number> = { a: 0.15, b: 0.05, c: 0.2, d: 0.1, e: 0.3 };
  const runFrom = Math.floor(n * 0.85);
  const out: StreamEntry[] = [];
  let clock = 0;
  for (let i = 0; i < n; i += 1) {
    // About one trace in six shares its timestamp with the one before.
    if (i === 0 || rng() > 1 / 6) clock += 1;
    const judged = rules.filter((r) => i >= firstJudged[r]);
    // Rule a's fail rate jumps once its baseline (about 200 evaluations) has settled.
    const shifted = i >= n * 0.35;
    const entry: StreamEntry = {
      traceId: `t${String(Math.floor(rng() * 1e6)).padStart(6, '0')}-${i}`,
      timestamp: ts(clock),
      judged,
      failed: judged.filter((r) => rng() < (r === 'a' && shifted ? 0.6 : rate[r])),
      runId: i >= runFrom ? (rng() < 0.5 ? 'run-x' : 'run-y') : null,
    };
    // A hand-built entry with no judged list is not an observation.
    if (i % 97 === 50) delete (entry as { judged?: unknown }).judged;
    out.push(entry);
  }
  // Storage hands the log over newest first; the functions must not care.
  return out.reverse();
}

describe('what a trace’s alarms depend on', () => {
  it('only on the trace and the entries timestamped before it: adding later entries changes none of them', () => {
    const log = hardLog('prefix');
    const sorted = [...log].sort((x, y) => (x.timestamp < y.timestamp ? -1 : x.timestamp > y.timestamp ? 1 : 0));
    const cut = sorted[Math.floor(sorted.length * 0.6)].timestamp;
    const early = log.filter((e) => e.timestamp <= cut);
    // Every fifth trace: each check re-runs the watchers over the prefix.
    for (const e of early.filter((_, i) => i % 5 === 0)) {
      expect(regressionAlarmsAt(log, e.traceId, e.timestamp), e.traceId).toEqual(regressionAlarmsAt(early, e.traceId, e.timestamp));
    }
  }, HEAVY_MS);

  it('not on a peer that shares its timestamp', () => {
    const log = hardLog('peers');
    const byTs = new Map<string, StreamEntry[]>();
    for (const e of log) byTs.set(e.timestamp, [...(byTs.get(e.timestamp) ?? []), e]);
    const shared = [...byTs.values()].filter((g) => g.length > 1);
    expect(shared.length).toBeGreaterThan(0);
    for (const group of shared.slice(0, 20)) {
      for (const e of group) {
        const withoutPeers = log.filter((x) => x.timestamp !== e.timestamp || x.traceId === e.traceId);
        expect(regressionAlarmsAt(log, e.traceId, e.timestamp)).toEqual(regressionAlarmsAt(withoutPeers, e.traceId, e.timestamp));
      }
    }
  }, HEAVY_MS);

  it('so one causal pass over the whole log is not the answer: a rule first judged later raises the family size an earlier alarm was drawn with', () => {
    const log = hardLog('family');
    const whole = regressionAlarms(log);
    const differing = whole.filter((a) => {
      const e = log.find((x) => x.traceId === a.traceId)!;
      const atTrace = regressionAlarmsAt(log, e.traceId, e.timestamp);
      return JSON.stringify(atTrace.filter((x) => x.rule === a.rule && x.run === a.run)) !== JSON.stringify([a]);
    });
    // The whole-log pass draws every line with the final family (5 rules,
    // doubled once runs appear); an alarm raised before rule d and the runs
    // appear was drawn, as of its trace, with a family of 4.
    expect(differing.length).toBeGreaterThan(0);
    expect(differing.every((a) => a.streams === 10)).toBe(true);
  }, HEAVY_MS);
});

describe('regressionAlarmsByTrace', () => {
  for (const seed of ['one', 'two', 'three', 'four']) {
    it(`equals regressionAlarmsAt for every trace (seed ${seed})`, () => {
      const log = hardLog(seed);
      const byTrace = regressionAlarmsByTrace(log);
      let alarmed = 0;
      for (const e of log) {
        const expected = regressionAlarmsAt(log, e.traceId, e.timestamp);
        expect(byTrace.get(e.traceId) ?? [], e.traceId).toEqual(expected);
        if (expected.length > 0) alarmed += 1;
      }
      // The comparison is not vacuous: alarms fired.
      expect(alarmed).toBeGreaterThan(0);
    }, HEAVY_MS);
  }

  it('costs a small fraction of asking per trace: 25 rules over a 500-trace window', () => {
    const rng = mulberry32(fnv1a('cost'));
    const judged = Array.from({ length: 25 }, (_, r) => `r${r}`);
    const rates = judged.map(() => 0.02 + rng() * 0.2);
    const log: StreamEntry[] = Array.from({ length: 500 }, (_, i) => ({
      traceId: `t${String(i).padStart(4, '0')}`,
      timestamp: ts(i),
      judged,
      failed: judged.filter((_, r) => rng() < rates[r]),
    }));
    const perTrace = (): void => {
      for (const e of log) regressionAlarmsAt(log, e.traceId, e.timestamp);
    };
    const onePass = (): void => {
      regressionAlarmsByTrace(log);
    };
    // Both draw the same simulated alarm lines, which are memoised: warm
    // them first, so the comparison is the watching and not the simulation.
    onePass();
    const cpu = (fn: () => void): number => {
      const start = process.cpuUsage();
      fn();
      const used = process.cpuUsage(start);
      return (used.user + used.system) / 1000;
    };
    const per = cpu(perTrace);
    const one = cpu(onePass);
    // Measured: about 940 ms per trace against 30 ms in one pass. CPU time,
    // so a busy machine slows both alike.
    expect(one).toBeLessThan(per / 5);
  }, HEAVY_MS);

  it('the moments history reads the same alarms from it as it computes on its own', () => {
    const log = hardLog('history').map((e) => ({ ...e, costUsd: null, failed: [...e.failed], judged: e.judged ? [...e.judged] : undefined, runId: e.runId ?? null }));
    const byTrace = regressionAlarmsByTrace(log);
    for (const e of log) {
      expect(historyBefore(log as never, e.traceId, e.timestamp, byTrace)).toEqual(historyBefore(log as never, e.traceId, e.timestamp));
    }
  }, HEAVY_MS);
});
