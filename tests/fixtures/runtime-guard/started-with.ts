/*
 * What a fresh process reads of the runtime guard as it was started, and
 * after applying the guard, and then a function run often enough that the
 * engine compiles it. The test starts it with the flags, or the
 * NODE_OPTIONS, under test, and with --trace-opt where it reads which
 * compiler tier the engine chose for `hotLoop`.
 *
 *   node [flags] --import tsx started-with.ts read     the state as started
 *   node [flags] --import tsx started-with.ts apply    the state, the guard, the state again
 */
const mode = process.argv[2] ?? 'read';
const guard = await import('../../../src/runtime-guard.js');
const before = guard.runtimeGuardState();
const after = mode === 'apply' ? guard.applyRuntimeGuard() : before;

function hotLoop(n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.sqrt(i) * 1.5;
  return sum;
}

let total = 0;
for (let round = 0; round < 400; round++) total += hotLoop(20_000);
// Give a compile job that is still running time to report before the process ends.
await new Promise((resolve) => setTimeout(resolve, 200));
process.stdout.write(`STATE ${before} ${after} ${total > 0}\n`);

export {};
