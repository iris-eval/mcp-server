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
 *   acts       the catalogue marks it `readOnlyHint: false` or
 *              `destructiveHint: true`; or, with no word from the
 *              catalogue, the first verb in its name acts (`send_email`,
 *              `slack_post_message`), or a verb directly after "and" does
 *              (`find_and_replace`), or the name has no verb and is a
 *              shell's or an interpreter's (`Bash`, `python`).
 *   reads      the catalogue marks it `readOnlyHint: true`, or the first
 *              verb in its name reads (`get_order`, `list_commits`).
 *   unplaced   neither says: `calculator`, `Glob`, `document_parse`; or
 *              the name can be read both ways (`search_and_bulk_update`).
 *
 * The name read is the tool's own: of `mcp__<server>__<tool>`, the part
 * after the server's (ownToolName).
 *
 * THE FIRST VERB DECIDES because a tool's name leads with what it does and
 * ends with what it does it to, and many of the words that act are also
 * things: an order, a post, a commit, a schedule, a refund, a run. Read as
 * "any word that acts", `get_order` and `get_commit` were actions, and so
 * was about one look-up in six on the list of published tool names this
 * reader is held to.
 *
 * Only a tool that acts is counted. A look-up or an unplaced tool that no
 * earlier run called is named in the result and never fails it. Counting
 * an unplaced name was tried first: it counted nearly every acting tool on
 * that list and a third of the look-ups with them, and on a vocabulary of
 * nouns it failed verdicts on ordinary variation. Of the 63 tools in the
 * runs this rule is measured on one name is unplaced, so no measured count
 * moved when it stopped. What the names cannot place (`Task`, `curl`, a
 * name in another language) the catalogue places, and the result names
 * each such tool so a deployment knows which to mark.
 * tests/unit/eval/tool-placement.test.ts holds the reader to three lists
 * of tool names it is measured on, one it was fitted on and two it was not.
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
 * Verbs that say a tool changes something, or runs something whose effect
 * its name cannot bound (`execute`, `call`, `run`). The first verb in a
 * name decides (placementOf), so `delete_list` acts and `get_order` reads,
 * though `list` reads and `order` acts.
 */
export const ACT_TOKENS: ReadonlySet<string> = new Set([
  'add', 'append', 'apply', 'approve', 'archive', 'assign', 'attach', 'ban', 'block', 'book', 'burn', 'buy', 'call', 'cancel', 'charge', 'checkout',
  'clear', 'click', 'close', 'comment', 'commit', 'copy', 'create', 'delete', 'deploy', 'deposit', 'destroy', 'detach', 'disable', 'dismiss', 'download',
  'drag', 'drop', 'edit', 'enable', 'escalate', 'exec', 'execute', 'fill', 'follow', 'fork', 'forward', 'grant', 'import', 'init', 'insert', 'install',
  'invite', 'invoke', 'kick', 'kill', 'launch', 'lock', 'mark', 'merge', 'migrate', 'mint', 'mkdir', 'modify', 'move', 'mute', 'mv', 'notify', 'order',
  'patch', 'pay', 'pin', 'post', 'press', 'provision', 'publish', 'purchase', 'purge', 'push', 'put', 'react', 'reboot', 'refund', 'register', 'reject',
  'remove', 'rename', 'replace', 'reply', 'rerun', 'reschedule', 'reserve', 'reset', 'restart', 'restore', 'retry', 'revert', 'revoke', 'rm', 'rmdir',
  'rollback', 'rotate', 'run', 'save', 'scale', 'schedule', 'sell', 'send', 'set', 'share', 'sign', 'spawn', 'stake', 'star', 'start', 'stop', 'store',
  'submit', 'subscribe', 'swap', 'sync', 'tap', 'terminate', 'toggle', 'transfer', 'trigger', 'truncate', 'unarchive', 'unfollow', 'unlock', 'unmute',
  'unpin', 'unstake', 'unstar', 'unsubscribe', 'update', 'upload', 'upsert', 'vote', 'wipe', 'withdraw', 'write',
]);

/**
 * Names for something that runs what it is given: a shell, an interpreter,
 * a computer. A tool named for one acts when its name holds no verb at
 * all (`Bash`, `python_repl`); with a verb, the verb decides, so
 * `get_shell_history` is a look-up.
 */
export const RUN_TOKENS: ReadonlySet<string> = new Set(['bash', 'cmd', 'computer', 'execution', 'interpreter', 'powershell', 'pwsh', 'python', 'repl', 'sh', 'shell', 'terminal', 'zsh']);

/**
 * Words that join two verbs in one name. A verb that acts directly after
 * one decides, whatever came first: `find_and_replace`, `get_or_create`.
 *
 * With other words between, the name can be read two ways and is not
 * placed: `search_and_bulk_update` acts and `get_name_and_address_for_order`
 * only reads, and nothing in either name says which. Counting both failed
 * verdicts on look-ups; reading both as look-ups dropped the actions from
 * the result without naming them. Unplaced, each is named with what places
 * it. A joiner whose own verb reads joins nothing that acts:
 * `food_and_beverage_get_order` is a look-up.
 */
const JOINERS: ReadonlySet<string> = new Set(['and', 'or', 'plus', 'then']);

/**
 * A tool's own name inside the name an agent calls it by. An agent that
 * reaches its tools through MCP calls them `mcp__<server>__<tool>`, and the
 * server part is the deployment's label for where the tool lives: a verb in
 * it says nothing of what the tool does. Read with it, every look-up on a
 * server named `store` would act and every action on one named `todo-list`
 * would read.
 */
export function ownToolName(name: string): string {
  if (!name.startsWith('mcp__')) return name;
  const at = name.indexOf('__', 'mcp__'.length);
  return at === -1 || at + 2 >= name.length ? name : name.slice(at + 2);
}

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
 * Where a name alone places a tool. The verbs are read in the tool's own
 * name (ownToolName): the first decides, a verb that acts directly after a
 * joiner decides whatever came first, and one that acts further on after a
 * joiner leaves a name that began by reading unplaced. With no verb of its
 * own, a name for something that runs commands acts, and there the server's
 * name counts too: a server that is a shell says where a command goes, so
 * `mcp__shell__command` acts as `shell_command` does. A name with neither
 * is not placed.
 */
export function placementByName(name: string): Placement {
  const words = nameWords(ownToolName(name));
  let first: Placement | null = null;
  // A joiner has been read and the verb it joins has not: `next` when the joiner was the word before, `apart` once a word that is no verb has come between.
  let joining: 'no' | 'next' | 'apart' = 'no';
  let twoReadings = false;
  for (const w of words) {
    if (JOINERS.has(w)) {
      joining = 'next';
      continue;
    }
    const kind: Placement | null = ACT_TOKENS.has(w) ? 'acts' : READ_TOKENS.includes(w) ? 'reads' : null;
    if (kind === null) {
      if (joining === 'next') joining = 'apart';
      continue;
    }
    const joined = joining;
    joining = 'no';
    if (first === null) first = kind;
    else if (kind === 'acts' && joined === 'next') return 'acts';
    else if (kind === 'acts' && joined === 'apart') twoReadings = true;
  }
  if (first === 'reads' && twoReadings) return 'unplaced';
  if (first !== null) return first;
  return nameWords(name).some((w) => RUN_TOKENS.has(w)) ? 'acts' : 'unplaced';
}

/**
 * Where a tool is placed: by the catalogue's word when it gives one, else
 * by its name's, else nowhere. The catalogue's word is `readOnlyHint`,
 * either way, or `destructiveHint: true` on a tool it does not call
 * read-only. A name is matched as the rules read it, by its first
 * MAX_TOOL_NAME_CHARS characters.
 */
export function placementOf(name: string, tools: readonly ToolDescriptor[] | undefined): Placement {
  const key = toolNameOf(name);
  const annotations = tools?.find((tool) => typeof tool.name === 'string' && toolNameOf(tool.name) === key)?.annotations;
  if (annotations?.readOnlyHint === true) return 'reads';
  if (annotations?.readOnlyHint === false || annotations?.destructiveHint === true) return 'acts';
  return placementByName(name);
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
