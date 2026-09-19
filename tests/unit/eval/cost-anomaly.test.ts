/*
 * Cost spikes are judged against the agent's own history, not a fixed
 * dollar figure (arc 7, D-7a; gap G22). The robust z — distance from the
 * median in MADs — on a seeded history; the floor below which nothing is
 * said; the zero-MAD fallback; and the guard that the old literal is gone
 * from src/.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COST_ANOMALY_MIN_HISTORY, COST_ANOMALY_WINDOW, COST_ANOMALY_Z, costAnomaly, describeCostAnomaly } from '../../../src/eval/cost-anomaly.js';
import { deriveMoment, historyBefore } from '../../../src/eval/decision-moment.js';
import { mulberry32 } from '../../../src/eval/stats.js';
import type { AgentFailureLogEntry } from '../../../src/types/query.js';
import type { Trace } from '../../../src/types/trace.js';
import type { EvalResult } from '../../../src/types/eval.js';

/** A seeded history of n costs around a centre, jittered ±20%, oldest first. */
function seededCosts(n: number, centre: number, seed = 7): number[] {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, () => centre * (0.8 + 0.4 * rng()));
}

describe('costAnomaly', () => {
  it('a trace twenty times the agent\'s usual cost is a spike; one at the usual cost is not', () => {
    const baseline = seededCosts(200, 0.01);
    const spike = costAnomaly(0.2, baseline)!;
    expect(spike.n).toBe(200);
    expect(spike.median).toBeCloseTo(0.01, 2);
    expect(spike.floored).toBe(false);
    expect(spike.z).toBeGreaterThan(COST_ANOMALY_Z);
    expect(spike.anomalous).toBe(true);
    const usual = costAnomaly(0.011, baseline)!;
    expect(usual.z).toBeLessThan(COST_ANOMALY_Z);
    expect(usual.anomalous).toBe(false);
  });

  it('the same dollar figure is a spike for a cheap agent and routine for a dear one', () => {
    expect(costAnomaly(0.15, seededCosts(100, 0.005))!.anomalous).toBe(true);
    expect(costAnomaly(0.15, seededCosts(100, 0.14))!.anomalous).toBe(false);
  });

  it('says nothing below the history floor, and reads at most the window', () => {
    expect(costAnomaly(5, seededCosts(COST_ANOMALY_MIN_HISTORY - 1, 0.01))).toBeNull();
    expect(costAnomaly(5, seededCosts(COST_ANOMALY_MIN_HISTORY, 0.01))).not.toBeNull();
    const long = [...seededCosts(COST_ANOMALY_WINDOW, 0.01), ...Array(50).fill(100)];
    // The first WINDOW entries are the baseline; the 50 hundred-dollar traces beyond it are not read.
    const a = costAnomaly(0.2, long)!;
    expect(a.n).toBe(COST_ANOMALY_WINDOW);
    expect(a.median).toBeCloseTo(0.01, 2);
  });

  it('a zero-MAD history falls back to a floor and says so, rather than an infinite z', () => {
    const flat = Array(30).fill(0.02);
    const a = costAnomaly(0.03, flat)!;
    expect(a.mad).toBe(0);
    expect(a.floored).toBe(true);
    expect(a.scale).toBeCloseTo(0.002, 6);
    expect(Number.isFinite(a.z)).toBe(true);
    expect(a.anomalous).toBe(true); // 0.01 over a $0.002 floor is five floors
    expect(costAnomaly(0.0201, flat)!.anomalous).toBe(false);
    const zeros = Array(30).fill(0);
    expect(costAnomaly(0.001, zeros)!.scale).toBe(0.0001);
    expect(costAnomaly(Number.NaN, flat)).toBeNull();
  });

  it('the sentence names the agent\'s own baseline, never a typed dollar line', () => {
    const s = describeCostAnomaly(costAnomaly(0.2, seededCosts(200, 0.01))!);
    expect(s).toContain('$0.2000');
    expect(s).toMatch(/median \$0\.0\d{3}, MAD \$0\.00\d{2} over its last 200 traces/);
    expect(s).toContain(`the spike line is ${COST_ANOMALY_Z}`);
    expect(s).not.toContain('0.10');
    const flat = describeCostAnomaly(costAnomaly(0.03, Array(30).fill(0.02))!);
    expect(flat).toContain('all cost $0.0200');
    expect(flat).toContain('floor');
  });
});

describe('the moment classifier reads the agent\'s own baseline', () => {
  const trace = (over: Partial<Trace> = {}): Trace => ({
    trace_id: 'subject',
    agent_name: 'bot',
    timestamp: '2026-09-19T12:00:00.000Z',
    output: 'ok',
    cost_usd: 0.2,
    ...over,
  });
  const pass: EvalResult = {
    id: 'e',
    trace_id: 'subject',
    eval_type: 'completeness',
    output_text: 'ok',
    score: 1,
    passed: true,
    rule_results: [{ ruleName: 'min_output_length', passed: true, score: 1, message: 'OK' }],
    suggestions: [],
  };
  const log = (costs: number[]): AgentFailureLogEntry[] =>
    costs.map((c, i) => ({ traceId: `t${i}`, timestamp: `2026-09-1${i % 9}T0${i % 10}:${String(i % 60).padStart(2, '0')}:00.000Z`, failed: [], costUsd: c }));

  it('a $0.20 trace over a $0.01 baseline is a cost-spike whose reason names the baseline', () => {
    const history = historyBefore(log(seededCosts(60, 0.01)), 'subject', '2026-09-19T12:00:00.000Z');
    expect(history.recentCosts).toHaveLength(60);
    const m = deriveMoment(trace(), [pass], history);
    expect(m.significance.kind).toBe('cost-spike');
    expect(m.significance.score).toBe(0.9);
    expect(m.significance.label).toContain('0.2000');
    expect(m.significance.reason).toContain("this agent's own baseline");
    expect(m.significance.reason).toContain('over its last 60 traces');
  });

  it('the same trace with no history, or with too little, is not a spike — nothing is said, not "fine"', () => {
    expect(deriveMoment(trace(), [pass]).significance.kind).toBe('normal-pass');
    const thin = historyBefore(log(seededCosts(COST_ANOMALY_MIN_HISTORY - 1, 0.01)), 'subject', '2026-09-19T12:00:00.000Z');
    expect(deriveMoment(trace(), [pass], thin).significance.kind).toBe('normal-pass');
  });

  it('a dear agent\'s ordinary trace is not a spike at the dollar figure the old literal flagged', () => {
    const history = historyBefore(log(seededCosts(60, 0.14)), 'subject', '2026-09-19T12:00:00.000Z');
    expect(deriveMoment(trace({ cost_usd: 0.15 }), [pass], history).significance.kind).toBe('normal-pass');
  });

  it('the history reads only the most recent costs before the trace, newest first, and skips traces without a cost', () => {
    const entries: AgentFailureLogEntry[] = [
      { traceId: 'after', timestamp: '2026-09-20T00:00:00.000Z', failed: [], costUsd: 99 },
      { traceId: 'self', timestamp: '2026-09-19T12:00:00.000Z', failed: [], costUsd: 99 },
      { traceId: 'nocost', timestamp: '2026-09-18T00:00:00.000Z', failed: [], costUsd: null },
      ...log(seededCosts(25, 0.01)),
    ];
    const h = historyBefore(entries, 'self', '2026-09-19T12:00:00.000Z');
    expect(h.recentCosts).toHaveLength(25);
    expect(h.recentCosts.every((c) => c < 0.02)).toBe(true);
  });
});

describe('the literal is gone', () => {
  it('no file under src/ carries a fixed cost-spike dollar threshold', () => {
    const root = resolve(__dirname, '..', '..', '..', 'src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && /COST_SPIKE_USD_THRESHOLD|cost-spike threshold/i.test(readFileSync(p, 'utf8'))) offenders.push(p.slice(root.length));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
