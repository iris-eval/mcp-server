/*
 * An evaluator built twice in a fresh process, with or without the runtime
 * guard applied first, and the warnings of Iris's own that the process
 * emitted. The test reads the lines this prints.
 *
 *   node --import tsx engine-warns.ts none                two evaluators, no guard
 *   node --import tsx engine-warns.ts guard               the guard, then two evaluators
 *   node --import tsx engine-warns.ts apply-after-import  the library imported as a host imports it, the guard applied through it, then two evaluators
 *   node --import tsx engine-warns.ts guard-worker        the guard, then two evaluators in a worker thread started after it
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

let state: string;
if (mode === 'guard-worker') {
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
  state = answer.state;
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
}
process.stdout.write(`STATE ${state}\n`);
process.stdout.write(`WARNINGS ${JSON.stringify(codes.filter((code) => code.startsWith('IRIS_')))}\n`);

export {};
