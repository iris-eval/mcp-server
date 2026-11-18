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
import * as threads from 'node:worker_threads';

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

/** Those releases, as a person writes them (`26.12.0`). */
export function releasesWithTheFix(): string[] {
  return Object.entries(FIXED_FROM).map(([major, [minor, patch]]) => `${major}.${minor}.${patch}`);
}

/**
 * The Node release an engine came in, read off a process's `versions`: its
 * `node` entry when the runtime is Node itself, and null for a runtime that
 * only answers as Node. Deno, Bun and Electron report a Node version for
 * the code they host, over an engine of their own build, so the release
 * that carries the fix says nothing about theirs: such a runtime is asked
 * by its engine's line alone.
 */
export function nodeVersionOf(versions: Readonly<Record<string, string | undefined>> = process.versions): string | null {
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
export function v8SharesNumbers(v8Version: string = process.versions.v8, nodeVersion: string | null = nodeVersionOf()): boolean {
  const parts = /^(\d+)\.(\d+)/.exec(v8Version);
  if (!parts) return false;
  const major = Number(parts[1]);
  const minor = Number(parts[2]);
  if (major < 12 || (major === 12 && minor < 5)) return false;
  if (major > 15 || (major === 15 && minor >= 2)) return false;
  const node = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/.exec(nodeVersion ?? '');
  if (!node) return true;
  const fixedFrom = FIXED_FROM[Number(node[1])];
  if (fixedFrom === undefined) return true;
  const [fixedMinor, fixedPatch] = fixedFrom;
  const nodeMinor = Number(node[2]);
  const nodePatch = Number(node[3]);
  // A pre-release (26.12.0-pre, a build of the line before the release) comes before the release, and may not carry the fix.
  const preRelease = node[4] !== undefined;
  return nodeMinor < fixedMinor || (nodeMinor === fixedMinor && (nodePatch < fixedPatch || (nodePatch === fixedPatch && preRelease)));
}

/**
 * What stands between a process and the defect:
 *   not_needed  its engine does not have it;
 *   started     the process was started with the tier off, or with no compiler at all;
 *   applied     the process turned the tier off (applyRuntimeGuard);
 *   unguarded   its engine has it and the tier is on.
 */
export type RuntimeGuardState = 'not_needed' | 'applied' | 'started' | 'unguarded';

/** Every state, in the order of the list above. */
export const RUNTIME_GUARD_STATES: readonly RuntimeGuardState[] = ['not_needed', 'started', 'applied', 'unguarded'];

/**
 * Whether the process was started with the tier off, or with no compiler at
 * all, read from Node's command line: `--no-maglev`, `--no_maglev` and
 * `--nomaglev` are one flag, so are `--jitless` and its negations, and of
 * two that disagree the last one stands. It is a reading of two flags, not
 * of the engine: a start that turns the tier off another way (in
 * NODE_OPTIONS, with one dash, or by a flag that implies it) reads as on,
 * and a few rare starts that turn it back on read as off (#1068). Iris's own
 * processes do not rest on it: the guard sets the flag whatever it reads.
 */
export function tierOffAtStart(execArgv: readonly string[]): boolean {
  const flags = new Map<string, boolean>();
  for (const arg of execArgv) {
    const name = /^--([A-Za-z0-9_-]+)$/.exec(arg)?.[1].replace(/_/g, '-');
    for (const flag of ['maglev', 'jitless']) {
      if (name === flag) flags.set(flag, true);
      else if (name === `no-${flag}` || name === `no${flag}`) flags.set(flag, false);
    }
  }
  return flags.get('jitless') === true || flags.get('maglev') === false;
}

/** The state, from the facts it rests on: whether the engine has the defect, what the process was started with (its command line), and whether the guard was applied in it. */
export function guardStateOf(affected: boolean, execArgv: readonly string[], applied: boolean): RuntimeGuardState {
  if (!affected) return 'not_needed';
  if (tierOffAtStart(execArgv)) return 'started';
  return applied ? 'applied' : 'unguarded';
}

/**
 * The guard's marks, one for the whole process. The engine's flags are the
 * process's, but a thread's globals are its own: so a mark is kept on the
 * thread (where two copies of this module, a bundle beside a package, read
 * one), and in the data every worker thread started after it is handed
 * (worker_threads' environment data), where the worker's own copy reads it.
 */
const APPLIED = '@iris-eval/mcp-server/runtime-guard.applied';
const WARNED = '@iris-eval/mcp-server/runtime-guard.warned';
const onThread = globalThis as unknown as Record<symbol, boolean | undefined>;

function marked(key: string): boolean {
  if (onThread[Symbol.for(key)] === true) return true;
  try {
    return threads.getEnvironmentData(key) === true;
  } catch {
    // A runtime without it keeps the mark to the thread.
    return false;
  }
}

function mark(key: string): void {
  onThread[Symbol.for(key)] = true;
  try {
    threads.setEnvironmentData(key, true);
  } catch {
    // A runtime without it keeps the mark to the thread.
  }
}

export function runtimeGuardState(): RuntimeGuardState {
  return guardStateOf(v8SharesNumbers(), process.execArgv, marked(APPLIED));
}

/**
 * Turn the tier off in this process, where its engine has the defect. For
 * a process Iris owns it is the first thing done (apply-runtime-guard.ts,
 * imported first by the entry point); a host that evaluates through the
 * library calls it once, before its first evaluation. Safe to call again.
 * The flag is set whatever the process was started with, and whatever the
 * reading above makes of it: where the tier is already off it changes
 * nothing, and where it is on, however the start reads, it is off after
 * this.
 * The engine's flags are the process's, so a worker thread started after
 * this runs with the tier off as well, and reads the guard as applied.
 */
export function applyRuntimeGuard(): RuntimeGuardState {
  if (!v8SharesNumbers()) return 'not_needed';
  try {
    v8.setFlagsFromString(TIER_OFF_FLAG);
    mark(APPLIED);
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
  if (state !== 'unguarded' || marked(WARNED)) return;
  mark(WARNED);
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
