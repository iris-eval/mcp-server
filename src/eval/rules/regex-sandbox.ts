import { Worker } from 'node:worker_threads';

/*
 * Hard-deadline execution for user-supplied regex patterns.
 *
 * Every prior guard on this path tried to PREDICT backtracking and lost:
 * safe-regex2 is star-height-only (judges `(a|a)*$` safe; it is exponential),
 * and the empirical deploy-time probe both ran the untrusted pattern on the
 * main thread — a single synchronous `.test()` measured at 43,380ms against a
 * 50ms budget, because `Date.now()` checks after a blocking call cannot
 * interrupt it — and depended on guessing an igniting payload, which is not
 * possible in general. A pattern that slipped past the probe hung the whole
 * server for every concurrent client on a 34-character input.
 *
 * This module stops predicting and makes overrun physically impossible: the
 * match runs in a worker thread while the calling thread blocks in
 * `Atomics.wait` with a timeout. On breach the worker is terminated
 * mid-backtrack and a fresh one is spawned for the next call. The API stays
 * synchronous, which is what the eval engine requires.
 *
 * The worker is a singleton, spawned lazily on the first custom-regex
 * evaluation and reused across calls (spawn costs ~20ms; a warm round-trip is
 * sub-millisecond). Calls are strictly sequential — the caller blocks — so
 * there is never more than one match in flight. `unref()` keeps the idle
 * worker from holding the process open.
 *
 * The worker source is embedded as a string (`eval: true`) so the same code
 * works from TS test context and from the built dist without bundler
 * path gymnastics. It is CommonJS, which is what eval-mode workers run.
 */

/** Wall-clock ceiling for a single `.test()` of a user pattern. Linear
 * patterns stay in the low milliseconds even on megabyte inputs; only a
 * superlinear pattern×input combination can approach this. */
export const REGEX_MATCH_BUDGET_MS = 100;

/** How long a fresh worker may take to boot before we give up on it. */
const WORKER_BOOT_TIMEOUT_MS = 5000;

const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
parentPort.on('message', ({ flag, pattern, flags, input }) => {
  const view = new Int32Array(flag);
  let status;
  const started = performance.now();
  try {
    status = new RegExp(pattern, flags).test(input) ? 1 : 2;
  } catch {
    status = 3;
  }
  // Slot 1: how long the match ITSELF ran, measured inside the worker.
  // Callers meter budgets on this, not on wall-clock, so OS scheduling
  // pressure on a busy host cannot masquerade as backtracking.
  Atomics.store(view, 1, Math.ceil(performance.now() - started));
  Atomics.store(view, 0, status);
  Atomics.notify(view, 0);
});
// Ready handshake LAST: by the time the spawner unblocks, the message
// listener above is installed and the first real match can be processed.
{
  const ready = new Int32Array(workerData);
  Atomics.store(ready, 0, 1);
  Atomics.notify(ready, 0);
}
`;

export type SandboxedRegexResult =
  | { kind: 'match'; matched: boolean; durationMs: number }
  | { kind: 'timeout' }
  | { kind: 'error' };

let worker: Worker | null = null;

function getWorker(): Worker {
  if (worker === null) {
    /*
     * Spawn, then BLOCK until the worker signals ready. Without this, the
     * ~20-60ms thread-boot cost lands inside the first caller's match
     * budget: the deploy probe's 50ms allowance expired during boot, the
     * still-booting worker was terminated as "backtracking", and the next
     * call paid spawn again — every ordinary pattern got rejected in a
     * spawn-kill loop. Boot happens once, outside any match budget.
     */
    const ready = new SharedArrayBuffer(4);
    const spawned = new Worker(WORKER_SOURCE, { eval: true, workerData: ready });
    // A crashed worker must not poison every later call: drop the handle so
    // the next call respawns. 'exit' also fires after our own terminate().
    spawned.on('error', () => {
      if (worker === spawned) worker = null;
    });
    spawned.on('exit', () => {
      if (worker === spawned) worker = null;
    });
    spawned.unref();
    Atomics.wait(new Int32Array(ready), 0, 0, WORKER_BOOT_TIMEOUT_MS);
    worker = spawned;
  }
  return worker;
}

/**
 * Runs `new RegExp(pattern, flags).test(input)` in the sandbox worker,
 * blocking the calling thread for at most `budgetMs`.
 *
 * `timeout` means the match was still backtracking at the deadline and the
 * worker was killed mid-match — the pattern is superlinear on this input.
 * `error` means the pattern failed to compile in the worker (callers
 * pre-validate syntax, so this is unexpected).
 */
export function sandboxedRegexTest(
  pattern: string,
  flags: string,
  input: string,
  budgetMs: number = REGEX_MATCH_BUDGET_MS,
): SandboxedRegexResult {
  // Fresh signal cells per call (slot 0 = status, slot 1 = worker-measured
  // duration): a terminated worker can never write into a later call's cells.
  const flag = new SharedArrayBuffer(8);
  const view = new Int32Array(flag);

  const w = getWorker();
  w.postMessage({ flag, pattern, flags, input });

  const outcome = Atomics.wait(view, 0, 0, budgetMs);
  if (outcome === 'timed-out') {
    // Still 0 → the worker is wedged inside .test(). Kill it mid-backtrack;
    // the 'exit' handler clears the singleton so the next call respawns.
    void w.terminate();
    worker = null;
    return { kind: 'timeout' };
  }

  // 'ok' (notified) or 'not-equal' (worker finished before we waited).
  const status = Atomics.load(view, 0);
  const durationMs = Atomics.load(view, 1);
  if (status === 1) return { kind: 'match', matched: true, durationMs };
  if (status === 2) return { kind: 'match', matched: false, durationMs };
  return { kind: 'error' };
}

/** Test hook: kills the singleton so suites can assert respawn behavior and
 * leave nothing running. Safe to call at any time. */
export function shutdownRegexSandbox(): void {
  if (worker !== null) {
    void worker.terminate();
    worker = null;
  }
}
