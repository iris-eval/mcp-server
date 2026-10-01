import { Worker, type WorkerOptions } from 'node:worker_threads';

/*
 * A thread does not take --import, so when Iris runs from its TypeScript
 * sources (tests, `npx tsx`) the thread registers tsx's loader itself, then
 * loads its entry. The entry arrives as the thread's last argv item, so the
 * code the thread evaluates is a constant: nothing is spliced into it.
 */
const BOOT = "import('tsx/esm/api').then((tsx) => { tsx.register(); return import(process.argv[process.argv.length - 1]); })";

/** Starts `entry` (a .ts file) on a thread that loads it through tsx. The built package never takes this path. */
export function sourceThread(entry: URL, options: WorkerOptions): Worker {
  return new Worker(BOOT, { ...options, eval: true, argv: [entry.href] });
}
