/*
 * An evaluator built twice in a fresh process, with or without the runtime
 * guard applied first, and the warnings of Iris's own that the process
 * emitted. The test reads the lines this prints.
 *
 *   node --import tsx engine-warns.ts none                two evaluators, no guard
 *   node --import tsx engine-warns.ts guard               the guard, then two evaluators
 *   node --import tsx engine-warns.ts library             the library imported as a host imports it, two evaluators built through it, the state read through it
 *   node --import tsx engine-warns.ts apply-after-import  the library imported as a host imports it, the guard applied through it, then two evaluators
 *   node --import tsx engine-warns.ts guard-worker        the guard, then two evaluators in a worker thread started after it
 *   node --import tsx engine-warns.ts none-then-worker    two evaluators, no guard, then two more in a worker thread started after the warning
 */
import { Worker } from 'node:worker_threads';

const mode = process.argv[2] ?? 'none';
if (mode === 'guard' || mode === 'guard-worker') await import('../../../src/apply-runtime-guard.js');

const codes: string[] = [];
process.on('warning', (warning) => codes.push(String((warning as NodeJS.ErrnoException).code ?? warning.name)));

/** The same, in a worker thread: the modules are loaded again there, as a host's worker loads them. A worker does not inherit the loader that reads TypeScript, so it registers it first. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const codes = [];
process.on('warning', (w) => codes.push(String(w.code ?? w.name)));
(async () => {
  (await import('tsx/esm/api')).register();
  const { EvalEngine } = await import(workerData.engine);
  const { defaultConfig } = await import(workerData.defaults);
  const { runtimeGuardState } = await import(workerData.guard);
  new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
  new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
  await new Promise((resolve) => setTimeout(resolve, 100));
  parentPort.postMessage({ state: runtimeGuardState(), codes });
})();
`;

/** Two evaluators built in a worker thread started now; its warnings join this thread's. */
async function inAWorker(): Promise<string> {
  const at = (path: string): string => new URL(path, import.meta.url).href;
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { engine: at('../../../src/eval/engine.ts'), defaults: at('../../../src/config/defaults.ts'), guard: at('../../../src/runtime-guard.ts') },
  });
  const answer = await new Promise<{ state: string; codes: string[] }>((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  await worker.terminate();
  codes.push(...answer.codes);
  return answer.state;
}

let state: string;
if (mode === 'guard-worker') {
  state = await inAWorker();
} else if (mode === 'library') {
  // As a host uses it: one import of the package's entry, the evaluator and the state both from it.
  const library = await import('../../../src/engine.js');
  new library.EvalEngine(library.defaultConfig.eval.defaultThreshold, library.defaultConfig.eval.ruleThresholds, library.defaultConfig.eval);
  new library.EvalEngine(library.defaultConfig.eval.defaultThreshold, library.defaultConfig.eval.ruleThresholds, library.defaultConfig.eval);
  await new Promise((resolve) => setTimeout(resolve, 100));
  state = library.runtimeGuardState();
} else {
  const library = mode === 'apply-after-import' ? await import('../../../src/engine.js') : undefined;
  library?.applyRuntimeGuard();
  const { EvalEngine } = await import('../../../src/eval/engine.js');
  const { defaultConfig } = await import('../../../src/config/defaults.js');
  const build = (): unknown => new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
  build();
  build();
  // A warning reaches its listeners on a later turn of the loop.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const { runtimeGuardState } = await import('../../../src/runtime-guard.js');
  state = runtimeGuardState();
  if (mode === 'none-then-worker') state = `${state} ${await inAWorker()}`;
}
process.stdout.write(`STATE ${state}\n`);
process.stdout.write(`WARNINGS ${JSON.stringify(codes.filter((code) => code.startsWith('IRIS_')))}\n`);

export {};
