/*
 * CPU time, for the tests that prove an input cannot stall a pattern.
 *
 * Those tests used to time a call with the wall clock and hold it under a
 * budget. The wall clock also counts the time the process spent waiting to
 * be scheduled. The root suite runs a fork per core, several of them
 * CPU-bound for 10-40 s, and on a busy machine a linear match of a few
 * hundred milliseconds measured over its one-second budget: the Email ReDoS
 * test failed at 1,297 ms in a stressed run. A catastrophic pattern costs
 * seconds to minutes of CPU, so CPU time tells linear from catastrophic
 * without depending on how busy the machine is.
 *
 * process.cpuUsage() counts every thread of the process, so the figure can
 * only overstate what the call used, never understate it.
 */

function cpuMsSince(start: NodeJS.CpuUsage): number {
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}

/** CPU milliseconds the process spent while `fn` ran. */
export function cpuMs(fn: () => unknown): number {
  const start = process.cpuUsage();
  fn();
  return cpuMsSince(start);
}

/** CPU milliseconds the process spent while `fn` ran and its promise settled. */
export async function cpuMsAsync(fn: () => Promise<unknown>): Promise<number> {
  const start = process.cpuUsage();
  await fn();
  return cpuMsSince(start);
}

/*
 * A budget in the terms of the process that is held to it.
 *
 * A second of CPU is not the same work everywhere this suite runs. One
 * evaluation of every bundle over 10,000 calls, the heaviest shape in
 * whole-run-cost.test.ts, measured on one laptop:
 *
 *   a performance core                      0.5 to 0.9 s
 *   the same under the suite's coverage     2.9 to 3.5 s   V8 counts every block a covered run enters
 *   an efficiency core                      1.5 to 2.1 s
 *   an efficiency core under coverage       7.4 to 8.8 s
 *
 * and 6.1 s on a hosted CI runner, where the suite always runs under
 * coverage. A budget of 6 s, set on the first line, held the code there and
 * the machine everywhere else: it failed on the fourth line, and once in CI
 * (2026-11-12) on a runner that ran the rest of the suite a fifth slower
 * than the run before, at a cost the code had had all along.
 *
 * So a budget for work of that kind is multiplied by how much slower this
 * process runs a fixed piece of plain JavaScript than the first line does.
 * That piece takes 13, 48, 32 and 120 ms on the four lines: 1, 3.6, 2.4 and
 * 9 times, where the evaluation is 1, about 5, 2.5 and about 12 times. The
 * multiplied budget is at least seven times what the evaluation costs on
 * the first line and at least six times on the fourth, so it is as sharp
 * everywhere as where it was written, and a little sharper under coverage.
 *
 * It is not for a budget on a regular expression. Coverage counts blocks of
 * JavaScript, not the steps of the engine that runs a pattern, so it costs
 * a pattern nothing (those of pii-pattern-redos.test.ts measure the same
 * with it and without), and a budget multiplied by 3.6 there would be 3.6
 * times too wide.
 */

/** What the fixed work takes where the budgets were measured: a performance core of a 2022 laptop processor, no coverage. */
export const FIXED_WORK_MS = 13;

/**
 * The fixed work, which is what the budgeted rules do all day in miniature:
 * values compared key by key, written out, and looked up by what they were
 * written as. None of it is the product's code, so a slower product cannot
 * widen its own budget. Changing it changes what FIXED_WORK_MS has to be.
 */
export function fixedWork(): number {
  const inputs = Array.from({ length: 1_200 }, (_, i) => ({ path: `src/f${i % 17}.ts`, a: [i % 7, i % 11, i % 13], n: i % 5 }));
  let same = 0;
  for (const x of inputs) {
    for (const y of inputs) {
      if (x.n !== y.n || x.path !== y.path || x.a.length !== y.a.length) continue;
      let equal = true;
      for (let k = 0; k < x.a.length; k += 1) {
        if (x.a[k] !== y.a[k]) {
          equal = false;
          break;
        }
      }
      if (equal) same += 1;
    }
  }
  const seen = new Map<string, number>();
  for (let round = 0; round < 20; round += 1) {
    for (const x of inputs) {
      const written = JSON.stringify(x);
      seen.set(written, (seen.get(written) ?? 0) + 1);
    }
  }
  return same + seen.size;
}

/** How many times slower than where the budgets were measured a process is that takes `ms` for the fixed work. Never under 1: a faster machine keeps a budget as it was written. */
export function paceOf(ms: number): number {
  return Math.max(1, ms / FIXED_WORK_MS);
}

let pace: number | undefined;

/**
 * `ms` of CPU where a budget was measured, as this process spends it.
 *
 * The pace is measured once for the process, by the wall clock, as the best
 * of five runs. The work is too short for process.cpuUsage(), which counts
 * in sixty-fourths of a second on Windows; the first run pays for compiling
 * it; and a run the scheduler interrupted is longer, never shorter, so the
 * best run is the machine's pace and a busy machine can only widen a
 * budget, never fail it.
 */
export function budgetHere(ms: number): number {
  if (pace === undefined) {
    let best = Infinity;
    for (let run = 0; run < 5; run += 1) {
      const started = performance.now();
      fixedWork();
      best = Math.min(best, performance.now() - started);
    }
    pace = paceOf(best);
  }
  return ms * pace;
}
