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
