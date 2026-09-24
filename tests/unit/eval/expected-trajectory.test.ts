/*
 * tool_sequence and step_budget: the paths the corpus families
 * cannot hold — every mode's definition on one small trajectory, the argument
 * matching, the skip reasons, and the evidence shape.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_STEP_TOLERANCE, callMatches, compareSequence, isSubset, stepBudget, toolSequence } from '../../../src/eval/rules/expected-trajectory.js';
import { toSteps } from '../../../src/eval/steps.js';
import type { EvalContext, ExpectedTrajectory } from '../../../src/types/eval.js';

const call = (tool: string, input?: unknown) => ({ tool_name: tool, ...(input !== undefined ? { input } : {}), output: 'ok' });
const steps = (...names: Array<string | [string, unknown]>) => toSteps({ toolCalls: names.map((n) => (Array.isArray(n) ? call(n[0], n[1]) : call(n))) });
const run = (rule: typeof toolSequence, ctx: Partial<EvalContext>) => rule.evaluate({ output: 'done', ...ctx } as EvalContext);
const expect3 = (mode: ExpectedTrajectory['mode']): ExpectedTrajectory => ({ tool_calls: [{ tool_name: 'read' }, { tool_name: 'grep' }, { tool_name: 'write' }], mode });

describe('compareSequence — the five modes on one trajectory', () => {
  const E = expect3('strict').tool_calls!;
  it('strict: equal, in order — an extra call or a swapped one fails, naming the position', () => {
    expect(compareSequence(E, steps('read', 'grep', 'write'), 'strict', 'subset').passed).toBe(true);
    const swapped = compareSequence(E, steps('grep', 'read', 'write'), 'strict', 'subset');
    expect(swapped.passed).toBe(false);
    expect(swapped.why).toMatch(/call 1 was grep, expected read/);
    const extra = compareSequence(E, steps('read', 'grep', 'write', 'bash'), 'strict', 'subset');
    expect(extra.passed).toBe(false);
    expect(extra.why).toMatch(/1 call beyond the 3 expected/);
    expect(extra.unexpected).toEqual([3]);
    const short = compareSequence(E, steps('read', 'grep'), 'strict', 'subset');
    expect(short.why).toMatch(/expected call 3 of 3, write, never came/);
  });
  it('unordered: equal as multisets — order is free, a missing or extra call is not', () => {
    expect(compareSequence(E, steps('write', 'read', 'grep'), 'unordered', 'subset').passed).toBe(true);
    expect(compareSequence(E, steps('write', 'read', 'grep', 'grep'), 'unordered', 'subset').why).toMatch(/1 call beyond the expected set/);
    expect(compareSequence(E, steps('write', 'read'), 'unordered', 'subset').why).toMatch(/1 of 3 expected calls never came \(first: grep\)/);
  });
  it('subset: every expected call present, anything else allowed', () => {
    expect(compareSequence(E, steps('bash', 'write', 'ls', 'read', 'grep'), 'subset', 'subset').passed).toBe(true);
    const r = compareSequence(E, steps('bash', 'write', 'read'), 'subset', 'subset');
    expect(r.passed).toBe(false);
    expect(r.matched).toBe(2);
    expect(r.missing.map((m) => m.tool_name)).toEqual(['grep']);
  });
  it('superset: no call outside the expected set, repeats and omissions allowed', () => {
    expect(compareSequence(E, steps('read', 'read', 'write'), 'superset', 'subset').passed).toBe(true);
    const r = compareSequence(E, steps('read', 'bash', 'write'), 'superset', 'subset');
    expect(r.passed).toBe(false);
    expect(r.unexpected).toEqual([1]);
    expect(r.why).toMatch(/1 call outside the expected set \(first: #1 bash\)/);
  });
  it('ordered_subset (the default): the expected calls appear in order among the actual ones — two pointers', () => {
    expect(compareSequence(E, steps('ls', 'read', 'bash', 'grep', 'read', 'write', 'ls'), 'ordered_subset', 'subset').passed).toBe(true);
    const out = compareSequence(E, steps('grep', 'read', 'write'), 'ordered_subset', 'subset');
    expect(out.passed).toBe(false);
    expect(out.why).toMatch(/expected call 2 of 3, grep, came out of order/);
    const never = compareSequence(E, steps('read', 'write'), 'ordered_subset', 'subset');
    expect(never.why).toMatch(/expected call 2 of 3, grep, never came/);
    expect(never.missing.map((m) => m.tool_name)).toEqual(['grep', 'write']);
  });
});

describe('argument matching', () => {
  it('an expectation without input matches any call of that name; with input, subset asks for the named keys, exact for the whole', () => {
    const [s] = steps(['read', { path: 'a.ts', mode: 'text' }]);
    expect(callMatches(s, { tool_name: 'read' }, 'subset')).toBe(true);
    expect(callMatches(s, { tool_name: 'read', input: { path: 'a.ts' } }, 'subset')).toBe(true);
    expect(callMatches(s, { tool_name: 'read', input: { path: 'b.ts' } }, 'subset')).toBe(false);
    expect(callMatches(s, { tool_name: 'read', input: { path: 'a.ts' } }, 'exact')).toBe(false);
    expect(callMatches(s, { tool_name: 'read', input: { mode: 'text', path: 'a.ts' } }, 'exact')).toBe(true);
    expect(callMatches(s, { tool_name: 'grep', input: { path: 'a.ts' } }, 'subset')).toBe(false);
  });
  it('isSubset: nested objects recurse, arrays and scalars must be equal, a string expectation against an object is not a match', () => {
    expect(isSubset({ a: { b: 1 } }, { a: { b: 1, c: 2 }, d: 3 })).toBe(true);
    expect(isSubset({ a: [1, 2] }, { a: [1, 2, 3] })).toBe(false);
    expect(isSubset('x', { x: 1 })).toBe(false);
    expect(isSubset('x', 'x')).toBe(true);
  });
  it('a specific expectation is matched before an unspecific one, so the unspecific one cannot take its call', () => {
    const expected = [{ tool_name: 'read' }, { tool_name: 'read', input: { path: 'a.ts' } }];
    const r = compareSequence(expected, steps(['read', { path: 'a.ts' }], ['read', { path: 'b.ts' }]), 'unordered', 'subset');
    expect(r.passed).toBe(true);
  });
});

describe('tool_sequence — the rule', () => {
  it('skips without an expectation, and without a trajectory, saying which', () => {
    const noExpectation = run(toolSequence, { toolCalls: [call('read')] });
    expect(noExpectation.skipped).toBe(true);
    expect(noExpectation.skipReason).toMatch(/expected_trajectory/);
    const noTrajectory = run(toolSequence, { expectedTrajectory: expect3('subset') });
    expect(noTrajectory.skipped).toBe(true);
    expect(noTrajectory.passed).toBe(false);
  });
  it('passes and fails by the mode, with the count evidence sourced to the call and the message naming the first difference', () => {
    const pass = run(toolSequence, { toolCalls: [call('read'), call('grep'), call('write')], expectedTrajectory: expect3(undefined) });
    expect(pass.passed).toBe(true);
    expect(pass.evidence).toEqual([{ type: 'count', stat: 'expected_calls_matched', unit: 'calls', value: 3, threshold: 3, thresholdSource: 'call' }]);
    const fail = run(toolSequence, { toolCalls: [call('read'), call('write')], expectedTrajectory: expect3('subset') });
    expect(fail.passed).toBe(false);
    expect(fail.message).toMatch(/1 of 3 expected calls never came \(first: grep\)/);
    expect(fail.score).toBeCloseTo(2 / 3);
    expect(fail.classes ?? toolSequence.classes).toEqual(['wrong_trajectory']);
  });
  it('an unknown mode falls back to ordered_subset and an unknown args mode to subset', () => {
    const r = run(toolSequence, { toolCalls: [call('ls'), call('read'), call('grep'), call('write')], expectedTrajectory: { ...expect3(undefined), mode: 'bogus' as never, args: 'bogus' as never } });
    expect(r.passed).toBe(true);
    expect(r.message).toMatch(/ordered_subset, args subset/);
  });
});

describe('step_budget — the rule', () => {
  it('skips without a budget (no step_budget and no expected calls), and without a trajectory', () => {
    expect(run(stepBudget, { toolCalls: [call('a')], expectedTrajectory: {} }).skipped).toBe(true);
    expect(run(stepBudget, { toolCalls: [call('a')] }).skipped).toBe(true);
    expect(run(stepBudget, { expectedTrajectory: { step_budget: 3 } }).skipped).toBe(true);
  });
  it('the ceiling is budget × tolerance (default 1.5): 4 expected calls allow 6, the seventh fails naming the overrun', () => {
    const four = expect3('subset');
    four.tool_calls!.push({ tool_name: 'bash' });
    const six = run(stepBudget, { toolCalls: Array.from({ length: 6 }, () => call('a')), expectedTrajectory: four });
    expect(six.passed).toBe(true);
    expect(six.evidence).toEqual([{ type: 'count', stat: 'tool_calls', unit: 'calls', value: 6, threshold: 4 * DEFAULT_STEP_TOLERANCE, thresholdSource: 'call' }]);
    const seven = run(stepBudget, { toolCalls: Array.from({ length: 7 }, () => call('a')), expectedTrajectory: four });
    expect(seven.passed).toBe(false);
    expect(seven.message).toMatch(/7 tool calls exceeds 4 × 1.5 = 6 \(1 over\)/);
    expect(seven.score).toBeCloseTo(6 / 7);
  });
  it('an explicit step_budget wins over the expected-call count, and a tolerance below 1 or malformed leaves the default standing', () => {
    const ctx = { toolCalls: Array.from({ length: 5 }, () => call('a')) };
    expect(run(stepBudget, { ...ctx, expectedTrajectory: { tool_calls: [{ tool_name: 'a' }], step_budget: 4 } }).passed).toBe(true);
    expect(run(stepBudget, { ...ctx, expectedTrajectory: { step_budget: 2, tolerance: 2 } }).passed).toBe(false);
    expect(run(stepBudget, { ...ctx, expectedTrajectory: { step_budget: 2, tolerance: 2.5 } }).passed).toBe(true);
    expect(run(stepBudget, { ...ctx, expectedTrajectory: { step_budget: 4, tolerance: 0.5 } }).message).toMatch(/4 × 1.5 = 6/);
    expect(run(stepBudget, { ...ctx, expectedTrajectory: { step_budget: 4, tolerance: Number.NaN } }).message).toMatch(/4 × 1.5 = 6/);
  });
});
