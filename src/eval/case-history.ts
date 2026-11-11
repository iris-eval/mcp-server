/*
 * A run against the earlier runs of its own case.
 *
 * `expected_trajectory` lets a caller say what a run should do, and most
 * callers never write one. A case that the same agent has run before has
 * already said it: what its earlier runs did. This module reads that record
 * and asks two things of a new run of the case:
 *
 *   an unusual action   it called a tool that may act, and no earlier run
 *                       in the window called it;
 *   a dropped step      it never called a tool every earlier run in the
 *                       window called.
 *
 * Nobody writes the expectation. It is whatever the case's own history
 * holds, so it moves when the case does and costs nothing to keep.
 *
 * WHY "NO EARLIER RUN" AND "EVERY EARLIER RUN", AND NOT A SHARE. The first
 * version drew its lines at a share of the earlier runs (a quarter or less,
 * three quarters or more). On an agent that has not changed, that fires for
 * as long as it runs: a step it takes one run in ten is "unusual" on nearly
 * every run that takes it, about one run in ten for ever. With the lines at
 * none and all, an agent with a steady habit of probability p fires on
 * p · (1 − p)^m of its runs at most, whatever p is:
 *
 *   earlier runs read (m)     3       5       10      20
 *   at most, of its runs      10.5%   6.7%    3.5%    1.8%
 *
 * Below CASE_HISTORY_MIN earlier runs nothing is said.
 *
 * WHAT THIS DOES NOT KNOW. A departure is not a fault: the case may have
 * changed, a tool may have been renamed (each rule then fires once, on the
 * first run after), or the earlier runs may all have been wrong together.
 * So what a fire is worth is measured on runs somebody else labelled, and
 * published per release (proof/OUTSIDE.md). The two rules that read this
 * are held to that measurement, and src/eval/rules/case-history.ts says
 * what each became by it: one is weighed in the verdict, one reports.
 *
 * A LOOK-UP IS NOT AN ACTION. Two runs of one task search differently and
 * act alike, so a look-up no earlier run made is exploration, while an
 * action no earlier run took is a departure. A tool is a look-up when the
 * catalogue marks it `readOnlyHint`, or, with no word from the catalogue,
 * when its name holds a word that reads (get, list, search, …) and none
 * that acts (send, delete, update, …): `delete_list` acts. A name that says
 * nothing either way is taken to act.
 *
 * ONE AGENT'S HISTORY. The earlier runs are the same agent's (the store
 * keys them by case and agent): one ask handed to two agents is one case
 * key and two histories.
 *
 * WHAT IS QUOTED. A tool's name, held to MAX_TOOL_NAME_CHARS: on an unusual
 * action it is this run's own, on a dropped step it comes from the earlier
 * runs, where every one of them called it. Nothing else of an earlier run
 * (no argument, no tool result, no answer) is read, kept or quoted.
 */
import type { CaseRun, EvalContext } from '../types/eval.js';
import type { Span, Step, ToolCallRecord, ToolDescriptor } from '../types/trace.js';
import { READ_TOKENS } from './catalogue.js';
import { MAX_STEPS_DERIVED, toSteps } from './steps.js';

export type { CaseRun };

/** How many of the case's most recent earlier runs are read. */
export const CASE_HISTORY_WINDOW = 20;

/** The fewest earlier runs that say anything: below it the rules report insufficient_history. */
export const CASE_HISTORY_MIN = 3;

/** The most distinct tools kept from one run. A run that called more is kept as one whose calls were not recorded. */
export const MAX_RUN_TOOLS = 200;

/**
 * The longest tool name kept. A name is whatever the caller sent, with no
 * limit of its own, and the rules store a run's names and quote them in the
 * results of later runs: past this a name is read by its first characters,
 * on the run being judged and on the earlier ones alike.
 */
export const MAX_TOOL_NAME_CHARS = 128;

/** The most tool names one message lists; the rest are counted. */
export const MAX_NAMES_IN_MESSAGE = 5;

/** A tool's name as the case-history rules read it. */
export function toolNameOf(name: string): string {
  return name.length > MAX_TOOL_NAME_CHARS ? name.slice(0, MAX_TOOL_NAME_CHARS) : name;
}

/**
 * The distinct tools of a derived trajectory, in first-call order, or null
 * when they cannot be listed whole: a call with no name, or more distinct
 * tools than MAX_RUN_TOOLS.
 */
export function toolsOfSteps(steps: readonly Step[]): string[] | null {
  const seen = new Set<string>();
  for (const step of steps) {
    if (typeof step.name !== 'string' || step.name.length === 0) return null;
    seen.add(toolNameOf(step.name));
    if (seen.size > MAX_RUN_TOOLS) return null;
  }
  return [...seen];
}

/**
 * One stored run as a CaseRun. The trajectory is the one derived reading
 * every trajectory rule takes (steps.ts): tool calls, or TOOL spans when
 * none were sent. An explicit empty list of tool calls is a run that made
 * no call. `tools` is null, and the run is then not counted among the
 * earlier runs, when its calls were not recorded (neither field), when it
 * made more calls than the step layer reads (a tool called only among the
 * rest would look as if it had never been called), or when a call cannot
 * be read at all.
 */
export function caseRunOf(run: { tool_calls?: ToolCallRecord[] | null; spans?: Span[] | null }): CaseRun {
  try {
    const calls = Array.isArray(run.tool_calls) ? run.tool_calls : undefined;
    const spans = Array.isArray(run.spans) ? run.spans : undefined;
    const available = calls !== undefined && calls.length > 0 ? calls.length : (spans?.filter((s) => s.kind === 'TOOL').length ?? 0);
    if (available > MAX_STEPS_DERIVED) return { tools: null };
    const steps = toSteps({ toolCalls: calls, spans });
    const recorded = steps.length > 0 || calls !== undefined;
    return { tools: recorded ? toolsOfSteps(steps) : null };
  } catch {
    return { tools: null };
  }
}

/* ------------------------------------------------------------------ *
 * A look-up, or an action
 * ------------------------------------------------------------------ */

/**
 * Words in a tool's name that say it changes something. One of them makes
 * the tool an action whatever else its name holds: `delete_list` and
 * `find_and_replace` act, though `list` and `find` read.
 */
export const ACT_TOKENS: ReadonlySet<string> = new Set([
  'add', 'append', 'apply', 'approve', 'archive', 'assign', 'ban', 'block', 'book', 'buy', 'call', 'cancel', 'charge', 'clear', 'close', 'commit',
  'copy', 'create', 'delete', 'deploy', 'disable', 'drop', 'edit', 'enable', 'exec', 'execute', 'forward', 'grant', 'import', 'insert', 'install',
  'invite', 'invoke', 'kick', 'kill', 'merge', 'modify', 'move', 'order', 'patch', 'pay', 'post', 'publish', 'purchase', 'purge', 'push', 'put',
  'refund', 'register', 'reject', 'remove', 'rename', 'replace', 'reply', 'reschedule', 'reserve', 'reset', 'restart', 'revoke', 'run', 'save',
  'schedule', 'sell', 'send', 'set', 'share', 'sign', 'start', 'stop', 'store', 'submit', 'subscribe', 'sync', 'transfer', 'truncate', 'unsubscribe',
  'update', 'upload', 'upsert', 'wipe', 'withdraw', 'write',
]);

/** The words of a tool's name, lowercased: split at anything that is not a letter or a digit, and where camelCase turns (`getUser`, `HTTPFetch`). */
export function nameWords(name: string): string[] {
  return toolNameOf(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

/** Whether a tool may act: the catalogue's word when it gives one, else its name's. A name is matched as the rules read it, by its first MAX_TOOL_NAME_CHARS characters. */
export function mayAct(name: string, tools: readonly ToolDescriptor[] | undefined): boolean {
  const key = toolNameOf(name);
  const declared = tools?.find((tool) => typeof tool.name === 'string' && toolNameOf(tool.name) === key)?.annotations?.readOnlyHint;
  if (declared === true) return false;
  if (declared === false) return true;
  const words = nameWords(name);
  if (words.some((w) => ACT_TOKENS.has(w))) return true;
  return !words.some((w) => READ_TOKENS.includes(w));
}

/* ------------------------------------------------------------------ *
 * The two readings
 * ------------------------------------------------------------------ */

type RecordedRun = CaseRun & { tools: readonly string[] };

/** The earlier runs that say something about tools: the window's, less the ones whose calls were not recorded. */
function recordedRuns(history: readonly CaseRun[]): RecordedRun[] {
  return history.slice(0, CASE_HISTORY_WINDOW).filter((r): r is RecordedRun => r.tools !== null);
}

function toolCounts(runs: ReadonlyArray<{ tools: readonly string[] }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const run of runs) for (const tool of new Set(run.tools)) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  return counts;
}

/** The tools among `called` that none of `runs` called, split by whether each may act. */
function neverCalled(called: Iterable<string>, runs: readonly RecordedRun[], tools: readonly ToolDescriptor[] | undefined): { actions: string[]; lookups: string[] } {
  const counts = toolCounts(runs);
  const actions: string[] = [];
  const lookups: string[] = [];
  for (const name of new Set(called)) {
    if (counts.has(name)) continue;
    (mayAct(name, tools) ? actions : lookups).push(name);
  }
  return { actions, lookups };
}

export interface ActionReading {
  /** Earlier runs whose calls were recorded. */
  m: number;
  /** Tools this run called that may act and that no earlier run called. */
  unusual: string[];
  /** Look-ups this run made that no earlier run made: noted, never counted. */
  unusualLookups: string[];
  /**
   * How many of the earlier runs themselves took an action none of the
   * other earlier runs took. null when there are too few to ask (each is
   * read against the rest, and the rest must number CASE_HISTORY_MIN).
   */
  departing: number | null;
}

/**
 * The tools this run called that no earlier run of its case did, split by
 * whether the tool may act. null below CASE_HISTORY_MIN earlier runs with
 * recorded calls.
 *
 * `departing` is the same question asked of each earlier run against the
 * rest. Where more than half of them depart from each other the case has
 * no usual way of going, and one more departure says nothing: the rule
 * that reads this declines there.
 */
export function unusualActions(called: readonly string[], tools: readonly ToolDescriptor[] | undefined, history: readonly CaseRun[]): ActionReading | null {
  const runs = recordedRuns(history);
  const m = runs.length;
  if (m < CASE_HISTORY_MIN) return null;
  const mine = neverCalled(called, runs, tools);
  let departing: number | null = null;
  if (m - 1 >= CASE_HISTORY_MIN) {
    departing = 0;
    for (const run of runs) {
      const rest = runs.filter((r) => r !== run);
      if (neverCalled(run.tools, rest, tools).actions.length > 0) departing += 1;
    }
  }
  return { m, unusual: mine.actions, unusualLookups: mine.lookups, departing };
}

/** More than half of the earlier runs depart from each other: the case has no usual way of going. */
export function hasNoUsualWay(reading: Pick<ActionReading, 'm' | 'departing'>): boolean {
  return reading.departing !== null && 2 * reading.departing > reading.m;
}

export interface StepReading {
  /** Earlier runs whose calls were recorded. */
  m: number;
  /** Tools every earlier run called that this run never did. */
  dropped: string[];
  /** How many tools every earlier run called: the steps this run was held to. */
  usual: number;
}

/**
 * The tools every earlier run of the case called that this run never
 * called. null below CASE_HISTORY_MIN earlier runs with recorded calls.
 */
export function droppedSteps(called: ReadonlySet<string>, history: readonly CaseRun[]): StepReading | null {
  const runs = recordedRuns(history);
  const m = runs.length;
  if (m < CASE_HISTORY_MIN) return null;
  const dropped: string[] = [];
  let usual = 0;
  for (const [name, k] of toolCounts(runs)) {
    if (k !== m) continue;
    usual += 1;
    if (!called.has(name)) dropped.push(name);
  }
  dropped.sort();
  return { m, dropped, usual };
}

/** The case history a context carries, never more than the window; undefined when the call carried none. */
export function caseHistoryOf(context: Pick<EvalContext, 'caseHistory'>): readonly CaseRun[] | undefined {
  return context.caseHistory?.slice(0, CASE_HISTORY_WINDOW);
}

/** Names for a message: the first MAX_NAMES_IN_MESSAGE, and how many more. */
export function listNames(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMES_IN_MESSAGE).join(', ');
  return names.length > MAX_NAMES_IN_MESSAGE ? `${shown} and ${names.length - MAX_NAMES_IN_MESSAGE} more` : shown;
}
