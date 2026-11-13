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
  }, 30_000); // 4.1 s under coverage on a CI runner, where the suite gives a test 5 s

  it('keeps the reasons and the order: each failure as the definition words it, in the order of the run', () => {
    const next = rng(77);
    const steps = toSteps({ toolCalls: Array.from({ length: 200 }, () => callOf(next)) });
    const fast = failuresIn(steps);
    const slow = byDefinition(steps);
    expect(fast.open.map((f) => [f.index, f.kind, f.reason])).toEqual(slow.open.map((f) => [f.index, f.kind, f.reason]));
    expect(fast.recovered.map((f) => [f.index, f.kind, f.reason])).toEqual(slow.recovered.map((f) => [f.index, f.kind, f.reason]));
  });

  it('a run with nothing failed is three empty lists', () => {
    expect(failuresIn(toSteps({ toolCalls: [{ tool_name: 'read_file', input: { path: 'a' }, output: 'ok' }] }))).toEqual({ open: [], recovered: [], undecided: [] });
    expect(failuresIn([])).toEqual({ open: [], recovered: [], undecided: [] });
  });

  it('leaves nothing undecided on the generated runs: the limit of work is for runs built to reach it', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = rng(seed);
      expect(failuresIn(toSteps({ toolCalls: Array.from({ length: Math.floor(next() * 200) }, () => callOf(next)) })).undecided, `seed ${seed}`).toEqual([]);
    }
  });

  it('a tool and a target are two things: a failure of one tool is not recovered by another whose name and target spell the same string', () => {
    // Joined into one key with a NUL between them, "a" on "b<NUL>c" and "a<NUL>b" on "c" were one key, and the first read as recovered by the second.
    const NUL = '\u0000';
    const collide = toSteps({
      toolCalls: [
        { tool_name: 'a', input: { path: `b${NUL}c` }, output: 'x', error: 'ENOENT: no such file or directory' },
        { tool_name: `a${NUL}b`, input: { path: 'c' }, output: 'contents' },
      ],
    });
    expect(indices(failuresIn(collide))).toEqual(indices(byDefinition(collide)));
    expect(failuresIn(collide).open).toHaveLength(1);
    // And a call that carries no name is not a call of a tool named "undefined".
    const unnamed = [
      { index: 0, name: undefined as unknown as string, input: { path: 'x' }, output: 'x', error: 'ENOENT: no such file or directory' },
      { index: 1, name: 'undefined', input: { path: 'x' }, output: 'contents' },
    ] as Step[];
    expect(indices(failuresIn(unnamed))).toEqual(indices(byDefinition(unnamed)));
    expect(failuresIn(unnamed).open).toHaveLength(1);
  });

  it('agrees with recoveredBy on runs whose names and targets hold a NUL, differ by case, or are missing', () => {
    const names = ['a', 'a\u0000b', 'A', 'read', ''];
    const targets = ['b\u0000c', 'c', 'C', '', 'x'.repeat(320)];
    for (let seed = 1; seed <= 1_500; seed += 1) {
      const next = rng(seed * 7 + 1);
      const calls = Array.from({ length: Math.floor(next() * 30) }, (): ToolCallRecord => {
        const tool_name = names[Math.floor(next() * names.length)];
        const shape = next();
        const input = shape < 0.6 ? { path: targets[Math.floor(next() * targets.length)] } : shape < 0.8 ? { ref: targets[Math.floor(next() * targets.length)], n: Math.floor(next() * 2) } : undefined;
        return next() < 0.4 ? { tool_name, input, output: 'x', error: 'ENOENT: no such file or directory' } : { tool_name, input, output: 'contents' };
      });
      const steps = toSteps({ toolCalls: calls });
      expect(indices(failuresIn(steps)), `seed ${seed}`).toEqual(indices(byDefinition(steps)));
    }
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

  it('a failure with no target is settled without reading every later call of its tool', () => {
    // 5,000 failures that named no target, then 5,000 calls of the tool that went right and carry all but the last of their six values. Asked of each later call in turn this was 25 million comparisons, 2 s of CPU.
    const given = [0, 1, 2, 3, 4, 5];
    const failures = Array.from({ length: 5_000 }, (): ToolCallRecord => ({ tool_name: 't', input: given, error: 'e' }));
    const rights = Array.from({ length: 5_000 }, (): ToolCallRecord => ({ tool_name: 't', input: given.slice(0, 5) }));
    const steps = toSteps({ toolCalls: [...failures, ...rights] });
    let result!: ReturnType<typeof failuresIn>;
    expect(cpuMs(() => (result = failuresIn(steps)))).toBeLessThan(1_500);
    // No later call carries the sixth value, so none recovered any of them.
    expect([result.open.length, result.recovered.length, result.undecided.length]).toEqual([5_000, 0, 0]);
    expect(indices(failuresIn(steps.slice(4_990, 5_010)))).toEqual(indices(byDefinition(steps.slice(4_990, 5_010))));
  });

  it('a run built to exhaust the search says which failures it did not settle, and neither passes nor fails them', () => {
    /*
     * Each failure was given two values. Half of the later calls carry the
     * first and half the second, and only the last call of the run carries
     * both: every failure is recovered, by a call found after reading every
     * carrier of one value. The search settles the first of them and stops.
     */
    const failures = Array.from({ length: 4_000 }, (): ToolCallRecord => ({ tool_name: 't', input: ['alpha', 'beta'], error: 'e' }));
    const halves = Array.from({ length: 5_998 }, (_, i): ToolCallRecord => ({ tool_name: 't', input: [i % 2 === 0 ? 'alpha' : 'beta', `n${i}`] }));
    const both: ToolCallRecord = { tool_name: 't', input: ['alpha', 'beta'] };
    const steps = toSteps({ toolCalls: [...failures, ...halves, both] });
    let result!: ReturnType<typeof failuresIn>;
    expect(cpuMs(() => (result = failuresIn(steps)))).toBeLessThan(3_000);
    expect(result.open).toHaveLength(0);
    expect(result.recovered.length).toBeGreaterThan(100);
    expect(result.undecided.length).toBeGreaterThan(1_000);
    expect(result.recovered.length + result.undecided.length).toBe(4_000);
    // What it settled, it settled as the definition does.
    expect(recoveredBy(result.recovered[0], steps.slice(result.recovered[0].index + 1))).toBe(true);
  });
});
