/*
 * A run against the earlier runs of its own case.
 *
 * `expected_trajectory` lets a caller say what a run should do, and most
 * callers never write one. A case that the same agent has run before has
 * already said it: what its earlier runs did. This module reads that record
 * and asks two things of a new run of the case:
 *
 *   an unusual action   it called a tool known to act, and no earlier run
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
 * WEIGHED FROM FIVE, REPORTED FROM THREE. Below CASE_HISTORY_MIN earlier
 * runs nothing is said. From there up to CASE_HISTORY_WEIGH_MIN the unusual
 * action is reported and takes no part in the verdict. Every run its error
 * rates were measured on was read against five earlier runs or more, and
 * read against three of them it fires more than twice as often where
 * nothing was wrong (proof/OUTSIDE.md, "At shorter histories"). A number
 * measured at five and up is not a number about three.
 *
 * WHAT THIS DOES NOT KNOW. A departure is not a fault: the case may have
 * changed, a tool may have been renamed (each rule then fires once, on the
 * first run after), or the earlier runs may all have been wrong together.
 * So what a fire is worth is measured on runs somebody else labelled, and
 * published per release (proof/OUTSIDE.md). The two rules that read this
 * are held to that measurement, and src/eval/rules/case-history.ts says
 * what each became by it: one is weighed in the verdict, one reports.
 *
 * COUNTED MEANS KNOWN TO ACT. Two runs of one task search differently and
 * act alike, so a look-up no earlier run made is exploration, while an
 * action no earlier run took is a departure. A tool is placed one of three
 * ways (placementOf):
 *
 *   acts       the catalogue marks it `readOnlyHint: false`, or, with no
 *              word from the catalogue, its name holds a word that acts
 *              (send, delete, update, …) or that runs something (execute,
 *              call, bash, …). One such word decides: `delete_list` acts.
 *   reads      the catalogue marks it `readOnlyHint: true`, or its name
 *              holds a word that reads (get, list, search, …) and none
 *              that acts.
 *   unplaced   neither says: `calculator`, `Glob`, `document_parse`.
 *
 * Only a tool that acts is counted. A look-up or an unplaced tool that no
 * earlier run called is named in the result and never fails it. Counting
 * an unplaced name was tried first: on a vocabulary of nouns it failed
 * verdicts on ordinary variation, and of the 63 tools in the runs this
 * rule is measured on one name is unplaced, so no measured count moved
 * when it stopped. A deployment whose unplaced tool acts says so in the
 * catalogue, and the result tells it which tools those are.
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

/**
 * The fewest earlier runs at which an unusual action is weighed in the
 * verdict: the fewest any run it was measured on was read against. With
 * fewer (CASE_HISTORY_MIN and up) it is reported and takes no part.
 */
export const CASE_HISTORY_WEIGH_MIN = 5;

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
 * Words in a tool's name that say it changes something, or that it runs
 * something whose effect the name cannot bound (`execute`, `call`, a
 * shell). One of them makes the tool an action whatever else its name
 * holds: `delete_list` and `find_and_replace` act, though `list` and `find`
 * read.
 */
export const ACT_TOKENS: ReadonlySet<string> = new Set([
  'add', 'append', 'apply', 'approve', 'archive', 'assign', 'ban', 'bash', 'block', 'book', 'buy', 'call', 'cancel', 'charge', 'clear', 'close', 'cmd',
  'commit', 'copy', 'create', 'delete', 'deploy', 'disable', 'drop', 'edit', 'enable', 'exec', 'execute', 'forward', 'grant', 'import', 'insert',
  'install', 'invite', 'invoke', 'kick', 'kill', 'merge', 'modify', 'move', 'order', 'patch', 'pay', 'post', 'powershell', 'publish', 'purchase',
  'purge', 'push', 'put', 'pwsh', 'refund', 'register', 'reject', 'remove', 'rename', 'replace', 'reply', 'reschedule', 'reserve', 'reset', 'restart',
  'revoke', 'run', 'save', 'schedule', 'sell', 'send', 'set', 'sh', 'share', 'shell', 'sign', 'start', 'stop', 'store', 'submit', 'subscribe', 'sync',
  'terminal', 'transfer', 'truncate', 'unsubscribe', 'update', 'upload', 'upsert', 'wipe', 'withdraw', 'write', 'zsh',
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

/** What is known of a tool: it acts, it reads, or neither the catalogue nor its name says. */
export type Placement = 'acts' | 'reads' | 'unplaced';

/**
 * Where a tool is placed: by the catalogue's word when it gives one, else
 * by its name's, else nowhere. A name is matched as the rules read it, by
 * its first MAX_TOOL_NAME_CHARS characters.
 */
export function placementOf(name: string, tools: readonly ToolDescriptor[] | undefined): Placement {
  const key = toolNameOf(name);
  const declared = tools?.find((tool) => typeof tool.name === 'string' && toolNameOf(tool.name) === key)?.annotations?.readOnlyHint;
  if (declared === true) return 'reads';
  if (declared === false) return 'acts';
  const words = nameWords(name);
  if (words.some((w) => ACT_TOKENS.has(w))) return 'acts';
  return words.some((w) => READ_TOKENS.includes(w)) ? 'reads' : 'unplaced';
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

/** The tools among `called` that none of `runs` called, split by where each is placed. */
function neverCalled(called: Iterable<string>, runs: readonly RecordedRun[], tools: readonly ToolDescriptor[] | undefined): { actions: string[]; lookups: string[]; unplaced: string[] } {
  const counts = toolCounts(runs);
  const actions: string[] = [];
  const lookups: string[] = [];
  const unplaced: string[] = [];
  for (const name of new Set(called)) {
    if (counts.has(name)) continue;
    const placement = placementOf(name, tools);
    (placement === 'acts' ? actions : placement === 'reads' ? lookups : unplaced).push(name);
  }
  return { actions, lookups, unplaced };
}

export interface ActionReading {
  /** Earlier runs whose calls were recorded. */
  m: number;
  /** Tools this run called that are known to act and that no earlier run called. */
  unusual: string[];
  /** Look-ups this run made that no earlier run made: noted, never counted. */
  unusualLookups: string[];
  /** Tools this run called that no earlier run called and that neither the catalogue nor the name places: noted, never counted. */
  unplaced: string[];
  /**
   * How many of the earlier runs themselves took an action none of the
   * other earlier runs took. null when there are too few to ask (each is
   * read against the rest, and the rest must number CASE_HISTORY_MIN).
   */
  departing: number | null;
}

/**
 * The tools this run called that no earlier run of its case did, split by
 * where each tool is placed. null below CASE_HISTORY_MIN earlier runs with
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
  return { m, unusual: mine.actions, unusualLookups: mine.lookups, unplaced: mine.unplaced, departing };
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
