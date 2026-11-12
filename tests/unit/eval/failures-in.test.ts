/*
 * failuresIn reads a run once; recoveredBy is the definition, one failure at
 * a time.
 *
 * Asked of each failure in turn, "did a later call recover this" read every
 * later output once per failure: n × f readings for a run of n calls with f
 * failures, which is what kept the rules from reading a long run whole
 * (#1013). failuresIn now reads each step once and answers from what it
 * kept. The answers have to be the same ones, because the proof family for
 * no_silent_tool_failure is labelled against the definition. This file
 * holds the two together on generated runs, and holds the cost.
 */
import { describe, expect, it } from 'vitest';
import { failureOf, failuresIn, recoveredBy, type StepFailure } from '../../../src/eval/rules/trajectory.js';
import { toSteps } from '../../../src/eval/steps.js';
import type { Step, ToolCallRecord } from '../../../src/types/trace.js';
import { cpuMs } from '../../helpers/cpu-time.js';

/** The definition applied to a whole run: each failure asked against the steps after it. */
function byDefinition(steps: readonly Step[]): { open: StepFailure[]; recovered: StepFailure[] } {
  const open: StepFailure[] = [];
  const recovered: StepFailure[] = [];
  for (const [index, step] of steps.entries()) {
    const failure = failureOf(step, index);
    if (failure === null) continue;
    (recoveredBy(failure, steps.slice(index + 1)) ? recovered : open).push(failure);
  }
  return { open, recovered };
}

/** A small deterministic generator, so a failure names its seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const TOOLS = ['read_file', 'search_code', 'run_tests', 'bash', 'http_get', 'write_file'];
const PATHS = ['src/a.ts', 'src/b.ts', 'docs/readme.md', 'pkg/core'];

/** One call of a kind the reading distinguishes: went right, failed with an error, reported a failing or a passing verdict, with or without a target. */
function callOf(next: () => number): ToolCallRecord {
  const tool = TOOLS[Math.floor(next() * TOOLS.length)];
  const path = PATHS[Math.floor(next() * PATHS.length)];
  const shape = next();
  // A target (path, query, command), a bare argument the reading takes for no target, or nothing at all.
  const input: Record<string, unknown> =
    shape < 0.5 ? (tool === 'bash' ? { command: `npm test -- ${path}` } : tool === 'search_code' ? { query: path } : { path }) : shape < 0.8 ? { ref: path, depth: Math.floor(next() * 3) } : {};
  const outcome = next();
  if (outcome < 0.15) return { tool_name: tool, input, output: 'x', error: 'ENOENT: no such file or directory' };
  if (outcome < 0.25) return { tool_name: tool, input, output: '{"status":"failed","error":"permission_denied"}' };
  if (outcome < 0.35) return { tool_name: tool, input, output: 'Error: connection reset by peer' };
  if (tool === 'run_tests' || tool === 'bash') {
    if (outcome < 0.55) return { tool_name: tool, input, output: 'Test Files  1 failed | 3 passed (4)\n     Tests  2 failed | 40 passed (42)' };
    if (outcome < 0.8) return { tool_name: tool, input, output: 'Test Files  4 passed (4)\n     Tests  42 passed (42)' };
  }
  return { tool_name: tool, input, output: `contents of ${path}` };
}

const indices = (r: { open: StepFailure[]; recovered: StepFailure[] }) => ({ open: r.open.map((f) => `${f.index}:${f.kind}`), recovered: r.recovered.map((f) => `${f.index}:${f.kind}`) });

describe('failuresIn — the same answers as the definition, read once', () => {
  it('agrees with recoveredBy on 3,000 generated runs of 0 to 60 calls', () => {
    let failuresSeen = 0;
    let recoveredSeen = 0;
    let reportedSeen = 0;
    for (let seed = 1; seed <= 3_000; seed += 1) {
      const next = rng(seed);
      const calls = Array.from({ length: Math.floor(next() * 61) }, () => callOf(next));
      const steps = toSteps({ toolCalls: calls });
      const fast = failuresIn(steps);
      const slow = byDefinition(steps);
      expect(indices(fast), `seed ${seed}`).toEqual(indices(slow));
      failuresSeen += slow.open.length + slow.recovered.length;
      recoveredSeen += slow.recovered.length;
      reportedSeen += [...slow.open, ...slow.recovered].filter((f) => f.kind === 'reported').length;
    }
    // The generator reaches every arm: failures left open, failures recovered, and a command's own verdict.
    expect(failuresSeen).toBeGreaterThan(10_000);
    expect(recoveredSeen).toBeGreaterThan(2_000);
    expect(failuresSeen - recoveredSeen).toBeGreaterThan(2_000);
    expect(reportedSeen).toBeGreaterThan(1_000);
  });

  it('keeps the reasons and the order: each failure as the definition words it, in the order of the run', () => {
    const next = rng(77);
    const steps = toSteps({ toolCalls: Array.from({ length: 200 }, () => callOf(next)) });
    const fast = failuresIn(steps);
    const slow = byDefinition(steps);
    expect(fast.open.map((f) => [f.index, f.kind, f.reason])).toEqual(slow.open.map((f) => [f.index, f.kind, f.reason]));
    expect(fast.recovered.map((f) => [f.index, f.kind, f.reason])).toEqual(slow.recovered.map((f) => [f.index, f.kind, f.reason]));
  });

  it('a run with nothing failed is two empty lists', () => {
    expect(failuresIn(toSteps({ toolCalls: [{ tool_name: 'read_file', input: { path: 'a' }, output: 'ok' }] }))).toEqual({ open: [], recovered: [] });
    expect(failuresIn([])).toEqual({ open: [], recovered: [] });
  });

  it('reads 10,000 calls inside a CPU budget whatever share of them failed', () => {
    // One call in seventy failing took 0.5 s here before, and the cost grew with the share. Every call failing, and half of them, are the shapes that grew fastest.
    const failing = (i: number): ToolCallRecord => ({ tool_name: 'read_file', input: { path: `src/f${i}.ts` }, output: 'x', error: 'ENOENT: no such file or directory' });
    const fine = (i: number): ToolCallRecord => ({ tool_name: 'read_file', input: { path: `src/f${i}.ts` }, output: `contents ${i}` });
    const bare = (i: number): ToolCallRecord => ({ tool_name: 'lookup', input: { ref: `r${i % 50}` }, output: i % 2 === 0 ? 'Error: not found' : 'found' });
    for (const [label, make] of [
      ['every call failed', failing],
      ['every other call failed', (i: number) => (i % 2 === 0 ? failing(i) : fine(i))],
      ['every other call failed, with no target to compare', bare],
    ] as const) {
      const steps = toSteps({ toolCalls: Array.from({ length: 10_000 }, (_, i) => make(i)) });
      expect(steps.length, label).toBe(10_000);
      let result!: ReturnType<typeof failuresIn>;
      expect(cpuMs(() => (result = failuresIn(steps))), label).toBeLessThan(3_000);
      expect(result.open.length + result.recovered.length, label).toBeGreaterThan(0);
    }
  });
});
