/*
 * compareSequence, held to the comparison it replaces.
 *
 * An expected sequence was compared with a run by asking each expected call
 * of each call made, and normalising both inputs again at every question:
 * 500 expected calls against a run of 10,000 took 9 s of CPU, and 68 s with
 * inputs of a thousand characters. The comparison now normalises each input
 * once and asks an expected call only of the calls of its tool.
 *
 * The answers have to be the same ones: the family for tool_sequence is
 * labelled against them. This file keeps the comparison as it was written,
 * and holds the two together on generated runs in every mode.
 */
import { describe, expect, it } from 'vitest';
import { compareSequence, isSubset, SEQUENCE_MODES, type SequenceOutcome } from '../../../src/eval/rules/expected-trajectory.js';
import { normaliseInput, stableStringify } from '../../../src/eval/rules/trajectory.js';
import { toSteps } from '../../../src/eval/steps.js';
import type { ExpectedArgsMode, ExpectedToolCall, ExpectedTrajectoryMode } from '../../../src/types/eval.js';
import type { Step, ToolCallRecord } from '../../../src/types/trace.js';

/** isSubset as it was: every scalar and array written out and compared as text. */
function isSubsetAsWritten(want: unknown, have: unknown): boolean {
  if (want === null || typeof want !== 'object' || Array.isArray(want)) return stableStringify(want) === stableStringify(have);
  if (have === null || typeof have !== 'object' || Array.isArray(have)) return false;
  const h = have as Record<string, unknown>;
  return Object.entries(want as Record<string, unknown>).every(([k, v]) => v === undefined || (k in h && isSubsetAsWritten(v, h[k])));
}
function matchesAsWritten(step: Step, expected: ExpectedToolCall, args: ExpectedArgsMode): boolean {
  if (step.name !== expected.tool_name) return false;
  if (expected.input === undefined) return true;
  return args === 'exact' ? normaliseInput(step.input) === normaliseInput(expected.input) : isSubsetAsWritten(expected.input, step.input);
}
/** compareSequence as it was: each expected call asked of each step. Only what decides the outcome is kept: pass or not, how many matched, which steps and which expected calls were left over. */
function compareAsWritten(expected: readonly ExpectedToolCall[], steps: readonly Step[], mode: ExpectedTrajectoryMode, args: ExpectedArgsMode): Pick<SequenceOutcome, 'passed' | 'matched' | 'unexpected'> & { missing: number } {
  const consume = (): { matchedExpected: Set<number>; matchedSteps: Set<number> } => {
    const matchedExpected = new Set<number>();
    const matchedSteps = new Set<number>();
    const order = expected.map((_, i) => i).sort((a, b) => Number(expected[b].input !== undefined) - Number(expected[a].input !== undefined) || a - b);
    for (const i of order) {
      for (let j = 0; j < steps.length; j += 1) {
        if (matchedSteps.has(j)) continue;
        if (matchesAsWritten(steps[j], expected[i], args)) {
          matchedExpected.add(i);
          matchedSteps.add(j);
          break;
        }
      }
    }
    return { matchedExpected, matchedSteps };
  };
  if (mode === 'strict') {
    const misplaced = expected.findIndex((e, k) => k >= steps.length || !matchesAsWritten(steps[k], e, args));
    const extra = steps.length > expected.length ? steps.slice(expected.length).map((s) => s.index) : [];
    const matched = expected.filter((e, k) => k < steps.length && matchesAsWritten(steps[k], e, args)).length;
    return { passed: misplaced === -1 && extra.length === 0, matched, unexpected: misplaced === -1 && extra.length === 0 ? [] : extra, missing: misplaced === -1 ? 0 : 1 };
  }
  if (mode === 'ordered_subset') {
    let i = 0;
    for (let j = 0; j < steps.length && i < expected.length; j += 1) if (matchesAsWritten(steps[j], expected[i], args)) i += 1;
    return { passed: i === expected.length, matched: i, unexpected: [], missing: expected.length - i };
  }
  if (mode === 'subset') {
    const absent = expected.filter((e) => !steps.some((s) => matchesAsWritten(s, e, args)));
    return { passed: absent.length === 0, matched: expected.length - absent.length, unexpected: [], missing: absent.length };
  }
  if (mode === 'superset') {
    const outside = steps.filter((s) => !expected.some((e) => matchesAsWritten(s, e, args)));
    return { passed: outside.length === 0, matched: expected.length, unexpected: outside.map((s) => s.index), missing: 0 };
  }
  const { matchedExpected, matchedSteps } = consume();
  const missing = expected.filter((_, i) => !matchedExpected.has(i)).length;
  const left = steps.filter((_, j) => !matchedSteps.has(j));
  return { passed: missing === 0 && left.length === 0, matched: expected.length - missing, unexpected: missing === 0 && left.length === 0 ? [] : left.map((s) => s.index), missing };
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const TOOLS = ['read_file', 'search', 'send_invoice', 'bash'];
const VALUES: unknown[] = ['a.ts', 'b.ts', ' a.ts ', 1, 1.0, 0, -0, true, false, null, [1, 2], [2, 1], { deep: 'x' }, { deep: 'y' }, 'A.TS'];

describe('compareSequence — each input read once, the same answers', () => {
  it('agrees with the comparison as it was written on 6,000 generated runs, in every mode and both ways of matching arguments', () => {
    let compared = 0;
    let passed = 0;
    for (let seed = 1; seed <= 6_000; seed += 1) {
      const next = rng(seed);
      const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
      const input = (): unknown => {
        const shape = next();
        if (shape < 0.15) return undefined;
        if (shape < 0.3) return pick(VALUES);
        const keys = ['path', 'query', 'n', 'opts'].filter(() => next() < 0.6);
        return Object.fromEntries(keys.map((k) => [k, pick(VALUES)]));
      };
      const calls = Array.from({ length: Math.floor(next() * 14) }, (): ToolCallRecord => ({ tool_name: pick(TOOLS), input: input() }));
      // Half of the expectations are drawn from the run itself, so that passes are as common as failures.
      const fromRun = next() < 0.5 && calls.length > 0;
      const expected = Array.from({ length: 1 + Math.floor(next() * 6) }, (): ExpectedToolCall => {
        if (fromRun) {
          const call = pick(calls);
          return next() < 0.5 ? { tool_name: call.tool_name } : { tool_name: call.tool_name, input: call.input };
        }
        return next() < 0.4 ? { tool_name: pick(TOOLS) } : { tool_name: pick(TOOLS), input: input() };
      });
      if (fromRun && next() < 0.5) expected.sort((a, b) => calls.findIndex((c) => c.tool_name === a.tool_name) - calls.findIndex((c) => c.tool_name === b.tool_name));
      const steps = toSteps({ toolCalls: calls });
      for (const mode of SEQUENCE_MODES) {
        for (const args of ['exact', 'subset'] as const) {
          const now = compareSequence(expected, steps, mode, args);
          const was = compareAsWritten(expected, steps, mode, args);
          const label = `seed ${seed}, ${mode}, ${args}`;
          expect(now.passed, label).toBe(was.passed);
          expect(now.matched, label).toBe(was.matched);
          expect(now.passed ? [] : now.unexpected, label).toEqual(was.unexpected);
          // strict names the one call out of place, ordered_subset every call from the first not found: the count is what the two are compared on.
          expect(now.missing.length, label).toBe(was.missing);
          compared += 1;
          if (now.passed) passed += 1;
        }
      }
    }
    expect(compared).toBe(60_000);
    // The generator reaches both answers many times over.
    expect(passed).toBeGreaterThan(8_000);
    expect(compared - passed).toBeGreaterThan(20_000);
  });

  it('isSubset compares two strings, two numbers and two booleans directly, and gives what writing them out gave', () => {
    const next = rng(31);
    const values: unknown[] = [...VALUES, '', '1', 'true', 'null', undefined, NaN, Infinity, 1e21, 0.1 + 0.2, 0.3, 'x'.repeat(400), { a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 3 }] } }];
    for (let i = 0; i < 20_000; i += 1) {
      const want = values[Math.floor(next() * values.length)];
      const have = values[Math.floor(next() * values.length)];
      expect(isSubset(want, have), `${stableStringify(want)} in ${stableStringify(have)}`).toBe(isSubsetAsWritten(want, have));
    }
    for (const a of values) for (const b of values) expect(isSubset({ k: a, other: 1 }, { k: b, other: 1, more: 2 })).toBe(isSubsetAsWritten({ k: a, other: 1 }, { k: b, other: 1, more: 2 }));
  });
});
