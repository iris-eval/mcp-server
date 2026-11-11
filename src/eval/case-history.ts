/*
 * A run against the earlier runs of its own case.
 *
 * `expected_trajectory` and `expected` let a caller say what a run should
 * do and what its answer should hold, and most callers never write either.
 * A case that has been run before has already said both: what its earlier
 * runs did, and what their answers agreed on. This module reads that
 * record and asks three things of a new run of the case:
 *
 *   an unusual action   it called a tool that may act, and the earlier runs
 *                       all but never called it;
 *   a dropped step      it never called a tool nearly every earlier run
 *                       called;
 *   a dropped specific  its answer lacks a figure, a date, an address or an
 *                       identifier that nearly every earlier answer carried.
 *
 * Nobody writes the expectation. It is whatever the case's own history
 * holds, so it moves when the case does and costs nothing to keep.
 *
 * THE SHARE. With k of m earlier runs doing a thing, its share is read as
 * (k + 1) / (m + 2), the rule of succession, and not as k / m. Three runs
 * that all called a tool are weaker evidence that the case always calls it
 * than thirty are, and k / m reads both as 1. A thing is UNUSUAL at a share
 * of a quarter or less and USUAL at three quarters or more:
 *
 *   m earlier runs      unusual when k is at most     usual when k is at least
 *   3, 4 or 5           0                             m
 *   6 to 9              1                             m − 1
 *   10 to 13            2                             m − 2
 *
 * Below CASE_HISTORY_MIN earlier runs nothing is said: three is the fewest
 * for which "no earlier run did this" clears the quarter line.
 *
 * WHAT THIS DOES NOT KNOW. An unusual action is a departure, and a
 * departure is not a fault: the case may have changed, or the earlier runs
 * may all have been wrong together. So the three rules that read this
 * (src/eval/rules/case-history.ts) are measurements. They report, and what
 * a departure is worth is published per release, measured on runs somebody
 * else labelled (proof/OUTSIDE.md).
 *
 * A LOOK-UP IS NOT AN ACTION. Two agents given one task search differently
 * and act alike, so a look-up no earlier run made is exploration, while an
 * action no earlier run took is a departure. Which a tool is comes from the
 * catalogue's `readOnlyHint` when the call carried one, and from the tool's
 * name otherwise (catalogue.ts, readFamilyOf). A tool the catalogue calls
 * read-only, or whose name says it reads, is noted and never counted. One
 * neither says anything about is taken to act.
 *
 * NOTHING FROM ANOTHER RUN IS COPIED INTO THIS ONE. A dropped specific is
 * reported by its kind, by how many earlier answers carried it, and by the
 * id of a trace that did. The text stays in the trace it came from, so
 * deleting that trace removes it.
 */
import type { CaseRun, EvalContext } from '../types/eval.js';
import type { Span, Step, ToolCallRecord, ToolDescriptor } from '../types/trace.js';
import { readFamilyOf } from './catalogue.js';
import { toSteps } from './steps.js';
import { readStructured } from './text/structured.js';

/** How many of the case's most recent earlier runs are read. */
export const CASE_HISTORY_WINDOW = 20;

/** The fewest earlier runs that say anything: below it the rules report insufficient_history. */
export const CASE_HISTORY_MIN = 3;

/** How much of an answer is read for its specifics. An answer, not a corpus. */
export const SPECIFICS_SCAN_CHARS = 20_000;

/** The most specifics kept from one answer. */
export const MAX_SPECIFICS = 200;

/** The longest run of characters read as one specific. Beyond it a run is a blob. */
export const MAX_SPECIFIC_CHARS = 128;

/** The most distinct tools kept from one run. */
export const MAX_RUN_TOOLS = 200;

export type { CaseRun };

/** The share k of m is read as: the rule of succession. */
export function shareOf(k: number, m: number): number {
  return (k + 1) / (m + 2);
}

/** A share of a quarter or less. In integers, so 2 of 6 is decided by arithmetic and not by rounding. */
export function isUnusual(k: number, m: number): boolean {
  return 4 * (k + 1) <= m + 2;
}

/** A share of three quarters or more. */
export function isUsual(k: number, m: number): boolean {
  return 4 * (k + 1) >= 3 * (m + 2);
}

/** The distinct tools of a derived trajectory, in first-call order. */
export function toolsOfSteps(steps: readonly Step[]): string[] {
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.size >= MAX_RUN_TOOLS) break;
    seen.add(step.name);
  }
  return [...seen];
}

/**
 * One stored run as a CaseRun. The trajectory is the one derived reading
 * every trajectory rule takes (steps.ts): tool calls, or TOOL spans when
 * none were sent. An explicit empty list of tool calls is a run that made
 * no call; neither field at all is a run whose calls were not recorded.
 */
export function caseRunOf(run: { trace_id?: string; tool_calls?: ToolCallRecord[] | null; spans?: Span[] | null; output?: string | null }): CaseRun {
  const steps = toSteps({ toolCalls: run.tool_calls ?? undefined, spans: run.spans ?? undefined });
  const recorded = steps.length > 0 || Array.isArray(run.tool_calls);
  const answered = typeof run.output === 'string' && run.output.trim() !== '';
  return {
    ...(run.trace_id !== undefined ? { traceId: run.trace_id } : {}),
    tools: recorded ? toolsOfSteps(steps) : null,
    specifics: answered ? specificsOf(answerAsRead(run.output as string)) : null,
  };
}

/**
 * An answer as no_dropped_specific reads it: an answer written as JSON is
 * read by the values it carries (text/structured.ts), which is the reading
 * the engine hands that rule, so an earlier answer and a new one are read
 * the same way.
 */
export function answerAsRead(output: string): string {
  return readStructured(output)?.values.text ?? output;
}

/* ------------------------------------------------------------------ *
 * Specifics
 * ------------------------------------------------------------------ */

const isDigit = (c: number): boolean => c >= 48 && c <= 57;

/*
 * What an ASCII character is to the scanner, in one table, so the pass over
 * an answer is a look-up per character: a digit, a letter, a character that
 * joins two word characters into one specific (3.5, 10:30, 2026-11-10,
 * a@b.co, v1.2, inv_7, 3/4), or one that ends a web address. The pass runs
 * when a trace is stored, on every trace that has a case, so its cost is
 * part of the cost of storing one.
 */
const DIGIT = 1;
const LETTER = 2;
const JOINER = 4;
const URL_END = 8;
const WORD = DIGIT | LETTER;
const CLASS = new Uint8Array(128);
for (let c = 48; c <= 57; c += 1) CLASS[c] = DIGIT;
for (let c = 65; c <= 90; c += 1) CLASS[c] = LETTER;
for (let c = 97; c <= 122; c += 1) CLASS[c] = LETTER;
for (const ch of '.:-_@/+') CLASS[ch.charCodeAt(0)] |= JOINER;
for (const ch of ' \t\n\r"\'<>)]}`|\\') CLASS[ch.charCodeAt(0)] |= URL_END;
const COMMA = 44;
const AT = 64;
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', '-', '_', '/', '+', '@'].map((c) => c.charCodeAt(0)));

/** A letter or a digit at `at`. Outside ASCII a letter is a character with a case, so a dash, a quote mark or an ellipsis still ends a run. */
function isWordAt(s: string, at: number): boolean {
  const c = s.charCodeAt(at);
  if (c < 128) return (CLASS[c] & WORD) !== 0;
  if (Number.isNaN(c)) return false;
  const ch = s[at];
  return ch.toLowerCase() !== ch.toUpperCase();
}

/** What kind of thing a specific is, for a message that names the kind and never the value. */
export type SpecificKind = 'number' | 'email address' | 'web address' | 'identifier';

export function kindOfSpecific(specific: string): SpecificKind {
  if (specific.startsWith('http://') || specific.startsWith('https://')) return 'web address';
  if (specific.includes('@')) return 'email address';
  for (let i = 0; i < specific.length; i += 1) {
    const c = specific.charCodeAt(i);
    if (!isDigit(c) && c !== 46) return 'identifier';
  }
  return 'number';
}

/** A specific described without its value: "a 4-digit number", "an email address", "an identifier of 11 characters". */
export function describeSpecific(specific: string): string {
  const kind = kindOfSpecific(specific);
  if (kind === 'number') {
    const digits = [...specific].filter((ch) => ch !== '.').length;
    return specific.includes('.') ? `a number of ${digits} digits with a decimal point` : `a ${digits}-digit number`;
  }
  if (kind === 'email address') return 'an email address';
  if (kind === 'web address') return 'a web address';
  return `an identifier of ${specific.length} characters`;
}

/** Exactly three digits from `at`, and no fourth: what follows a thousands separator. */
function threeDigitsThenNone(s: string, at: number): boolean {
  if (at + 2 >= s.length) return false;
  if (!isDigit(s.charCodeAt(at)) || !isDigit(s.charCodeAt(at + 1)) || !isDigit(s.charCodeAt(at + 2))) return false;
  return !(at + 3 < s.length && isDigit(s.charCodeAt(at + 3)));
}

/** A pure number in one written form: 1,050.00 and 1050 are the same figure. null when the token is not a pure number. */
function canonicalNumber(token: string): string | null {
  let dots = 0;
  for (let i = 0; i < token.length; i += 1) {
    const c = token.charCodeAt(i);
    if (c === 46) dots += 1;
    else if (!isDigit(c) && c !== COMMA) return null;
  }
  if (dots > 1) return null;
  const plain = token.replaceAll(',', '');
  const [whole, fraction = ''] = plain.split('.');
  const w = whole.replace(/^0+(?=\d)/, '');
  const f = fraction.replace(/0+$/, '');
  return f.length > 0 ? `${w}.${f}` : w;
}

/**
 * The specifics an answer carries: its figures, dates, times, addresses and
 * identifiers, each in one written form, in the order they first appear.
 *
 * A specific is a run of letters and digits, joined across a single . : - _
 * @ / or + that sits between two of them, that either holds a digit or is
 * an email address; or a web address, read from its `http://` or `https://`
 * to the next space, quote or closing bracket. A comma joins only as a
 * thousands separator (a comma, then exactly three digits). A pure number
 * of one digit is not one: it is a list marker far more often than a fact.
 *
 * One forward pass, no regular expression, over at most the first
 * SPECIFICS_SCAN_CHARS characters.
 */
export function specificsOf(text: string): string[] {
  const s = text.length > SPECIFICS_SCAN_CHARS ? text.slice(0, SPECIFICS_SCAN_CHARS) : text;
  const out = new Set<string>();
  const met = new Set<string>();
  const n = s.length;
  let i = 0;
  while (i < n && out.size < MAX_SPECIFICS) {
    const c = s.charCodeAt(i);
    if (c < 128 ? (CLASS[c] & WORD) === 0 : !isWordAt(s, i)) {
      i += 1;
      continue;
    }
    // A web address: the scheme, then everything to the next space, quote or closing bracket.
    if ((c === 104 || c === 72) && (s.startsWith('http://', i) || s.startsWith('https://', i) || s.startsWith('HTTP://', i) || s.startsWith('HTTPS://', i))) {
      let end = i;
      while (end < n) {
        const ch = s.charCodeAt(end);
        if (ch < 128 && (CLASS[ch] & URL_END) !== 0) break;
        end += 1;
      }
      let stop = end;
      while (stop > i && TRAILING_PUNCTUATION.has(s.charCodeAt(stop - 1))) stop -= 1;
      if (stop - i <= MAX_SPECIFIC_CHARS) out.add(s.slice(i, stop).toLowerCase());
      i = end;
      continue;
    }
    let end = i + 1;
    let hasDigit = c < 128 && (CLASS[c] & DIGIT) !== 0;
    let hasAt = false;
    while (end < n) {
      const ch = s.charCodeAt(end);
      if (ch >= 128) {
        if (!isWordAt(s, end)) break;
        end += 1;
        continue;
      }
      const cls = CLASS[ch];
      if ((cls & WORD) !== 0) {
        if ((cls & DIGIT) !== 0) hasDigit = true;
        end += 1;
        continue;
      }
      if ((cls & JOINER) !== 0 && end + 1 < n && isWordAt(s, end + 1)) {
        if (ch === AT) hasAt = true;
        end += 1;
        continue;
      }
      // A comma joins only as a thousands separator: after a digit, with exactly three digits after it.
      if (ch === COMMA && isDigit(s.charCodeAt(end - 1)) && threeDigitsThenNone(s, end + 1)) {
        end += 1;
        continue;
      }
      break;
    }
    // Most runs are plain words: nothing is cut from the answer for them. A run met before is not read twice.
    if ((hasDigit || hasAt) && end - i <= MAX_SPECIFIC_CHARS) {
      const written = s.slice(i, end);
      if (!met.has(written)) {
        met.add(written);
        const token = written.toLowerCase();
        const number = canonicalNumber(token);
        if (number === null) {
          // An email address needs a dot after its @; anything else with an @ and no digit is a handle, not a specific.
          if (hasDigit || token.indexOf('.', token.indexOf('@')) > 0) out.add(token);
        } else if (number.length >= 2) {
          out.add(number);
        }
      }
    }
    i = end;
  }
  return [...out];
}

/* ------------------------------------------------------------------ *
 * The three readings
 * ------------------------------------------------------------------ */

/** A tool this run called, with how many of the earlier runs called it. */
export interface ToolShare {
  name: string;
  /** Earlier runs that called it. */
  k: number;
  /** Whether it may act: false when the catalogue or its name says it only reads. */
  acts: boolean;
}

export interface ActionReading {
  /** Earlier runs whose calls were recorded. */
  m: number;
  /** Tools this run called that may act and that the earlier runs all but never called. */
  unusual: ToolShare[];
  /** Look-ups this run made that the earlier runs all but never made: noted, never counted. */
  unusualLookups: ToolShare[];
  /**
   * How many of the earlier runs themselves took an action the other
   * earlier runs all but never took. null when there are too few to ask
   * (each is read against the rest, and the rest must number
   * CASE_HISTORY_MIN).
   */
  departing: number | null;
}

type RecordedRun = CaseRun & { tools: readonly string[] };

function recordedRuns(history: readonly CaseRun[]): RecordedRun[] {
  return history.slice(0, CASE_HISTORY_WINDOW).filter((r): r is RecordedRun => r.tools !== null);
}

function toolCounts(runs: ReadonlyArray<{ tools: readonly string[] }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const run of runs) for (const tool of new Set(run.tools)) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  return counts;
}

/** Whether a tool may act: anything the catalogue does not mark read-only and whose name does not say it reads. */
export function mayAct(name: string, tools: readonly ToolDescriptor[] | undefined): boolean {
  return readFamilyOf({ name } as Step, tools) !== 'read';
}

/** The tools among `called` that at most a quarter of `runs` called, by the share. */
function unusualAmong(called: Iterable<string>, runs: readonly RecordedRun[], tools: readonly ToolDescriptor[] | undefined): ToolShare[] {
  const counts = toolCounts(runs);
  const m = runs.length;
  const out: ToolShare[] = [];
  for (const name of new Set(called)) {
    const k = counts.get(name) ?? 0;
    if (isUnusual(k, m)) out.push({ name, k, acts: mayAct(name, tools) });
  }
  return out;
}

/**
 * The tools this run called that the earlier runs of its case all but
 * never did, split by whether the tool may act. null below
 * CASE_HISTORY_MIN earlier runs with recorded calls.
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
  const shares = unusualAmong(called, runs, tools);
  let departing: number | null = null;
  if (m - 1 >= CASE_HISTORY_MIN) {
    departing = 0;
    for (const run of runs) {
      const rest = runs.filter((r) => r !== run);
      if (unusualAmong(run.tools, rest, tools).some((t) => t.acts)) departing += 1;
    }
  }
  return { m, unusual: shares.filter((t) => t.acts), unusualLookups: shares.filter((t) => !t.acts), departing };
}

/** More than half of the earlier runs depart from each other: the case has no usual way of going. */
export function hasNoUsualWay(reading: Pick<ActionReading, 'm' | 'departing'>): boolean {
  return reading.departing !== null && 2 * reading.departing > reading.m;
}

export interface StepReading {
  /** Earlier runs whose calls were recorded. */
  m: number;
  /** Tools nearly every earlier run called that this run never did. */
  dropped: Array<{ name: string; k: number }>;
  /** How many tools nearly every earlier run called: the steps this run was held to. */
  usual: number;
}

/**
 * The tools nearly every earlier run of the case called that this run never
 * called. null below CASE_HISTORY_MIN earlier runs with recorded calls.
 */
export function droppedSteps(called: ReadonlySet<string>, history: readonly CaseRun[]): StepReading | null {
  const runs = recordedRuns(history);
  const m = runs.length;
  if (m < CASE_HISTORY_MIN) return null;
  const dropped: Array<{ name: string; k: number }> = [];
  let usual = 0;
  for (const [name, k] of toolCounts(runs)) {
    if (!isUsual(k, m)) continue;
    usual += 1;
    if (!called.has(name)) dropped.push({ name, k });
  }
  dropped.sort((a, b) => b.k - a.k || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { m, dropped, usual };
}

export interface SpecificReading {
  /** Earlier runs that stored an answer. */
  m: number;
  /** Specifics nearly every earlier answer carried that this one does not, each with a trace that carried it. */
  dropped: Array<{ specific: string; k: number; traceId?: string }>;
  /** How many specifics nearly every earlier answer carried: what this answer was held to. */
  usual: number;
}

/**
 * The specifics nearly every earlier answer of the case carried that this
 * answer does not. null below CASE_HISTORY_MIN earlier runs with an answer.
 */
export function droppedSpecifics(answer: string, history: readonly CaseRun[]): SpecificReading | null {
  const runs = history.slice(0, CASE_HISTORY_WINDOW).filter((r): r is CaseRun & { specifics: readonly string[] } => r.specifics !== null);
  const m = runs.length;
  if (m < CASE_HISTORY_MIN) return null;
  const counts = new Map<string, { k: number; traceId?: string }>();
  for (const run of runs) {
    for (const specific of new Set(run.specifics)) {
      const seen = counts.get(specific);
      if (seen) seen.k += 1;
      else counts.set(specific, { k: 1, ...(run.traceId !== undefined ? { traceId: run.traceId } : {}) });
    }
  }
  const mine = new Set(specificsOf(answer));
  const dropped: SpecificReading['dropped'] = [];
  let usual = 0;
  for (const [specific, { k, traceId }] of counts) {
    if (!isUsual(k, m)) continue;
    usual += 1;
    if (!mine.has(specific)) dropped.push({ specific, k, ...(traceId !== undefined ? { traceId } : {}) });
  }
  dropped.sort((a, b) => b.k - a.k || (a.specific < b.specific ? -1 : a.specific > b.specific ? 1 : 0));
  return { m, dropped, usual };
}

/** The case history a context carries, never more than the window. */
export function caseHistoryOf(context: Pick<EvalContext, 'caseHistory'>): readonly CaseRun[] {
  return (context.caseHistory ?? []).slice(0, CASE_HISTORY_WINDOW);
}

/** "0 of 6 earlier runs", in the words every message of the three rules uses. */
export function ofEarlierRuns(k: number, m: number, noun: 'run' | 'answer' = 'run'): string {
  return `${k} of ${m} earlier ${noun}${m === 1 ? '' : 's'}`;
}
