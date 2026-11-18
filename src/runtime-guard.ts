/*
 * A defect of the JavaScript engine that Iris guards its own processes
 * against.
 *
 * V8's middle compiler tier, Maglev, can hand back objects that share the
 * storage of their fractional numbers. When code that tier compiled gives
 * up part-way (a deoptimisation) and an object it had not yet built for
 * real has to be rebuilt, the boxed number of a field was rebuilt once for
 * the compiled code and not once for each time it gave up: two objects
 * rebuilt at the same place hold the same box, the code that carries on
 * writes its values into it, and the earlier object then reads the later
 * one's numbers. The language has no way to make two objects share a
 * field: this is the engine's (nodejs/node#66457; fixed in V8 15.2 by
 * 7d5eb1df, "Materialize a fresh HeapNumber per deoptimization").
 *
 * The report shows it in a function that runs a long loop and builds an
 * object with fractional numbers after it: the engine swaps the running
 * loop for compiled code that has never seen what follows the loop, and
 * gives up there. V8's own regression test reaches it with no loop at all,
 * so the fault is the tier's and not that swap's, and it matters to
 * whoever keeps such an object. Iris kept one per rule for the life of a
 * process, the published interval (eval/accuracy.ts), and in a process
 * that started on a busy machine one rule's rows could carry another
 * rule's miss rate until the process ended. That place no longer keeps
 * objects, but the defect is the engine's, and every result holds numbers:
 * so a process Iris owns turns the tier off before anything has run often
 * enough to reach it.
 *
 * Which engines. Node 24 (V8 13.6): every release so far; the fix is
 * proposed for that line and not released (nodejs/node#66567, open on
 * 2026-11-17, when 24.22.3 was the newest). Node 26 (V8 14.6): before
 * 26.12.0, the first release that carries the fix. Node 22 (V8 12.4) does
 * not have it. A V8 version does not say whether a fix was carried back
 * into it, so the guard goes by the engine's line, 12.5 up to 15.2, and
 * stands down only for a Node release known to carry the fix.
 */
import v8 from 'node:v8';

/** The report of the defect, for a message or a page to point at. */
export const SHARED_NUMBERS_REPORT = 'https://github.com/nodejs/node/issues/66457';

/** The flag that turns the tier off. Whole, not only its swap of a running loop: the fault is in how the tier rebuilds an object when its code gives up, on any road into that code. */
export const TIER_OFF_FLAG = '--no-maglev';

/**
 * The first release of a Node line that carries the fix back, by the
 * line's major number. 26: 26.12.0 (the cherry-pick of 7d5eb1df is in that
 * tag and not in 26.11.1). 24 has none yet.
 */
const FIXED_FROM: Readonly<Record<number, readonly [minor: number, patch: number]>> = { 26: [12, 0] };

/**
 * The version of Node this process runs on, when the runtime is Node
 * itself. A runtime that only answers as Node (it reports a Node version
 * for the code it hosts, over an engine of its own build) is asked by its
 * engine's line alone.
 */
function nodeOwnVersion(): string | null {
  const versions: Readonly<Record<string, string | undefined>> = process.versions;
  return versions['deno'] === undefined && versions['bun'] === undefined && versions['electron'] === undefined ? (versions['node'] ?? null) : null;
}

/**
 * Whether an engine of this version can share numbers between objects: its
 * line is 12.5 up to, not including, 15.2, and it is not a Node release
 * known to carry the fix. Node 22's 12.4 was measured clean by the report;
 * nothing between it and 13.6 shipped in a release that is still kept up,
 * so those count as affected.
 *
 * `nodeVersion` is the Node release the engine came in, and null for an
 * engine that is not Node's own build, which is asked by its line alone.
 */
export function v8SharesNumbers(v8Version: string = process.versions.v8, nodeVersion: string | null = nodeOwnVersion()): boolean {
  const parts = /^(\d+)\.(\d+)/.exec(v8Version);
  if (!parts) return false;
  const major = Number(parts[1]);
  const minor = Number(parts[2]);
  if (major < 12 || (major === 12 && minor < 5)) return false;
  if (major > 15 || (major === 15 && minor >= 2)) return false;
  const node = /^v?(\d+)\.(\d+)\.(\d+)/.exec(nodeVersion ?? '');
  if (!node) return true;
  const fixedFrom = FIXED_FROM[Number(node[1])];
  if (fixedFrom === undefined) return true;
  const [fixedMinor, fixedPatch] = fixedFrom;
  const nodeMinor = Number(node[2]);
  return nodeMinor < fixedMinor || (nodeMinor === fixedMinor && Number(node[3]) < fixedPatch);
}

/**
 * What stands between a process and the defect:
 *   not_needed  its engine does not have it;
 *   applied     the process turned the tier off (applyRuntimeGuard);
 *   started     the process was started with the tier off;
 *   unguarded   its engine has it and the tier is on.
 */
export type RuntimeGuardState = 'not_needed' | 'applied' | 'started' | 'unguarded';

/** The state, from the three facts it rests on: whether the engine has the defect, what the process was started with, and whether the guard was applied in it. */
export function guardStateOf(affected: boolean, execArgv: readonly string[], applied: boolean): RuntimeGuardState {
  if (!affected) return 'not_needed';
  if (applied) return 'applied';
  // Started with the tier off, or with every compiler off.
  return execArgv.some((arg) => arg === TIER_OFF_FLAG || arg === '--jitless') ? 'started' : 'unguarded';
}

/** One mark for the whole process, so that two copies of this module (a bundle beside a package) agree. */
const APPLIED = Symbol.for('@iris-eval/mcp-server/runtime-guard.applied');
const WARNED = Symbol.for('@iris-eval/mcp-server/runtime-guard.warned');
const marks = globalThis as unknown as Record<symbol, boolean | undefined>;

export function runtimeGuardState(): RuntimeGuardState {
  return guardStateOf(v8SharesNumbers(), process.execArgv, marks[APPLIED] === true);
}

/**
 * Turn the tier off in this process, where its engine has the defect. For
 * a process Iris owns it is the first thing done (apply-runtime-guard.ts,
 * imported first by the entry point); a host that evaluates through the
 * library calls it once, before its first evaluation. Safe to call again.
 * The engine's flags are the process's, so a worker thread started after
 * this runs with the tier off as well.
 */
export function applyRuntimeGuard(): RuntimeGuardState {
  const state = runtimeGuardState();
  if (state !== 'unguarded') return state;
  try {
    v8.setFlagsFromString(TIER_OFF_FLAG);
    marks[APPLIED] = true;
  } catch {
    // An engine that will not take the flag stays as it was, and the state says so.
  }
  return runtimeGuardState();
}

/** The code of the warning below, as Node reports it (`warning.code`, and in the line it prints). */
export const SHARED_NUMBERS_WARNING = 'IRIS_SHARED_NUMBERS';

/** What the library says, once, of a process that has the defect and no guard. */
export function unguardedWarning(node: string = process.version, v8Version: string = process.versions.v8): string {
  return (
    `This Node (${node}, V8 ${v8Version}) can make a number in one evaluation result read as another result's: a defect of its compiler (${SHARED_NUMBERS_REPORT}). ` +
    `Start Node with ${TIER_OFF_FLAG}, or call applyRuntimeGuard() from '@iris-eval/mcp-server/engine' before the first evaluation. The Iris server and CLI do this themselves.`
  );
}

/**
 * Said once, by the library, when it is about to evaluate in a process
 * that has the defect and no guard. A library does not change its host's
 * engine: it says what the host can do.
 */
export function warnIfUnguarded(state: RuntimeGuardState = runtimeGuardState()): void {
  if (state !== 'unguarded' || marks[WARNED] === true) return;
  marks[WARNED] = true;
  process.emitWarning(unguardedWarning(), { type: 'IrisRuntimeWarning', code: SHARED_NUMBERS_WARNING });
}

/** What a page that describes this process says of its runtime. */
export interface RuntimeReport {
  node: string;
  v8: string;
  /** Whether this engine can share numbers between objects, and what stands in the way. */
  sharedNumbers: { affected: boolean; guard: RuntimeGuardState; see: string };
}

export function runtimeReport(): RuntimeReport {
  return {
    node: process.versions.node,
    v8: process.versions.v8,
    sharedNumbers: { affected: v8SharesNumbers(), guard: runtimeGuardState(), see: SHARED_NUMBERS_REPORT },
  };
}

/** The same, as one line a person reads (the self-test's report). */
export function runtimeLine(report: RuntimeReport = runtimeReport()): string {
  const runtime = `Node ${report.node} (V8 ${report.v8})`;
  switch (report.sharedNumbers.guard) {
    case 'not_needed':
      return runtime;
    case 'applied':
      return `${runtime}; its compiler can make two results share their numbers, and Iris turned that tier off at start (${report.sharedNumbers.see})`;
    case 'started':
      return `${runtime}; its compiler can make two results share their numbers, and Node was started with that tier off (${report.sharedNumbers.see})`;
    case 'unguarded':
      return `${runtime}; its compiler can make two results share their numbers and nothing stands in the way: start Node with ${TIER_OFF_FLAG} (${report.sharedNumbers.see})`;
  }
}
