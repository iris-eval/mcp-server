/*
 * The linearity tripwires measure CPU time (tests/helpers/cpu-time.ts), so
 * a busy machine cannot fail them. This holds the two properties they rely
 * on: waiting is not counted, and work is. And it holds what a budget given
 * in the process's own terms relies on: the pace is a ratio to one fixed
 * piece of work, it never narrows a budget, and it is taken once.
 */
import { describe, it, expect } from 'vitest';
import { FIXED_WORK_MS, budgetHere, cpuMs, cpuMsAsync, fixedWork, paceOf } from '../helpers/cpu-time.js';

describe('cpuMs', () => {
  it('does not count time spent waiting', () => {
    const started = performance.now();
    const cpu = cpuMs(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300));
    expect(performance.now() - started).toBeGreaterThanOrEqual(290);
    expect(cpu).toBeLessThan(150);
  });

  it('counts time spent computing', () => {
    const cpu = cpuMs(() => {
      const end = process.cpuUsage().user + 50_000;
      while (process.cpuUsage().user < end) {
        // spin for 50 ms of user CPU
      }
    });
    expect(cpu).toBeGreaterThanOrEqual(50);
  });

  it('cpuMsAsync does not count an await on a timer', async () => {
    const cpu = await cpuMsAsync(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(cpu).toBeLessThan(150);
  });
});

describe('budgetHere', () => {
  it('the fixed work is the same work every time: 1,200 values that each equal only themselves, and 1,200 ways of writing them', () => {
    // FIXED_WORK_MS is what this work takes where the budgets were measured. Work that changed would need it measured again.
    expect(fixedWork()).toBe(2_400);
    expect(fixedWork()).toBe(2_400);
  });

  it('a process as fast as the one the budgets were measured on, or faster, keeps a budget as written; a slower one has it in proportion', () => {
    expect(paceOf(FIXED_WORK_MS)).toBe(1);
    expect(paceOf(FIXED_WORK_MS / 3)).toBe(1);
    expect(paceOf(FIXED_WORK_MS * 3.6)).toBeCloseTo(3.6, 10);
    expect(paceOf(FIXED_WORK_MS * 9)).toBe(9);
  });

  it('the pace is taken once for the process, and every budget is multiplied by the same one', () => {
    const here = budgetHere(1_000);
    expect(here).toBeGreaterThanOrEqual(1_000);
    expect(budgetHere(1_000)).toBe(here);
    expect(budgetHere(6_000)).toBeCloseTo(here * 6, 6);
  });
});
