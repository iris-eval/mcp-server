/*
 * A function run often enough that the engine compiles it, with or without
 * the runtime guard applied first, on the main thread or in a worker thread
 * started afterwards. Run with --trace-opt, the engine prints which
 * compiler tier it chose for `hotLoop`; the test reads that.
 *
 *   node --trace-opt --import tsx hot.ts guard           the guard, then the loop
 *   node --trace-opt --import tsx hot.ts none            the loop alone
 *   node --trace-opt --import tsx hot.ts guard-worker    the guard, then the loop in a worker thread
 *   node --trace-opt --import tsx hot.ts none-worker     the loop in a worker thread, no guard
 */
import { Worker } from 'node:worker_threads';

const mode = process.argv[2] ?? 'none';
if (mode.startsWith('guard')) await import('../../../src/apply-runtime-guard.js');

/** The same loop, as the source of a worker thread: the server's own workers (the regex sandbox, the checkpointer, the search worker) are started after the guard, as this one is. */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
function hotLoop(n) {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.sqrt(i) * 1.5;
  return sum;
}
let total = 0;
for (let round = 0; round < 400; round++) total += hotLoop(20000);
// Give a compile job that is still running time to report before the thread ends.
setTimeout(() => parentPort.postMessage(total > 0), 200);
`;

function hotLoop(n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.sqrt(i) * 1.5;
  return sum;
}

let done = false;
if (mode.endsWith('-worker')) {
  const worker = new Worker(WORKER_SOURCE, { eval: true });
  done = await new Promise<boolean>((resolve, reject) => {
    worker.once('message', (ok: boolean) => resolve(ok));
    worker.once('error', reject);
  });
  await worker.terminate();
} else {
  let total = 0;
  for (let round = 0; round < 400; round++) total += hotLoop(20_000);
  // Give a compile job that is still running time to report before the process ends.
  await new Promise((resolve) => setTimeout(resolve, 200));
  done = total > 0;
}
process.stdout.write(`DONE ${done}\n`);

export {};
