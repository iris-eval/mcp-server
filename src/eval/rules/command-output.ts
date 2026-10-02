/*
 * What a command's output REPORTS.
 *
 * `isFailedCall` (trajectory.ts) answers "did the call fail": an error
 * field, an error-shaped first line. A test run that ends "3 failed, 12
 * passed" is neither. The call succeeded, the command ran to the end, and
 * its output says the thing it was run to check is broken. Until 0.20.0 no
 * rule read that: an answer of "All tests pass" beside a runner's "Tests  3
 * failed" passed every rule, because the first line of the output was the
 * runner's banner.
 *
 * This file reads the verdict a test runner, a build tool or a shell
 * leaves in its output. Three things keep it narrow:
 *
 *   - only a tool that RUNS A COMMAND is read this way (ranACommand). A
 *     file read whose content happens to carry "3 failed" is a successful
 *     read of a file that says so;
 *   - only the head and the tail of the output are read, where a runner
 *     prints what it found, and only lines short enough to be a verdict;
 *   - a count ("3 failed") is a verdict only on a line made of nothing but
 *     a runner's summary vocabulary, so a passing test NAMED "retries after
 *     3 failed attempts" is not one.
 *
 * No regular expression with an ambiguous quantifier scans the output:
 * lines are split, lower-cased and tokenised, and matched against fixed
 * lists. Tool output is attacker-controlled (trajectory.ts says why that
 * matters on a single-threaded server).
 */
import type { ToolCallRecord } from '../../types/trace.js';

/** How much of the START of a command's output is read for a verdict. */
export const VERDICT_HEAD_CHARS = 400;
/** How much of the END. A runner's summary is the last thing it prints. */
export const VERDICT_TAIL_CHARS = 2_000;
/** A longer line is not a verdict: a minified bundle, a JSON blob, a paragraph. */
export const VERDICT_LINE_MAX = 240;

/**
 * Words in a tool's name that say it runs a command. Matched against the
 * name split at punctuation and at lower-to-upper case boundaries, so
 * `run_tests`, `runTests` and `Bash` match and `truncate` does not.
 */
export const COMMAND_TOOL_WORDS: readonly string[] = [
  'bash', 'shell', 'sh', 'zsh', 'powershell', 'pwsh', 'cmd', 'terminal', 'exec', 'execute', 'command',
  'run', 'test', 'tests', 'build', 'lint', 'make', 'npm', 'pytest', 'cargo',
];

/** Input keys whose string value is a command line. */
export const COMMAND_INPUT_KEYS: readonly string[] = ['command', 'cmd', 'script'];

/** Did this call run a command? By its name, or by carrying a command line. */
export function ranACommand(call: ToolCallRecord): boolean {
  const words = call.tool_name
    .slice(0, 100)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  if (words.some((w) => COMMAND_TOOL_WORDS.includes(w))) return true;
  const input = call.input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
  return COMMAND_INPUT_KEYS.some((key) => typeof (input as Record<string, unknown>)[key] === 'string');
}

/** Colour and cursor codes, which runners write around the very words read here. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * The lines a verdict may sit on: every whole line in the first
 * VERDICT_HEAD_CHARS and the last VERDICT_TAIL_CHARS, trimmed, colour
 * removed. A line cut by either window is dropped rather than read: half a
 * line can read as its opposite ("10 failed" cut to "0 failed", "XFAIL" cut
 * to "FAIL").
 */
export function verdictLines(text: string): string[] {
  const clean = (lines: string[]): string[] =>
    lines.map((l) => stripAnsi(l).trim()).filter((l) => l.length > 0 && l.length <= VERDICT_LINE_MAX);
  if (text.length <= VERDICT_HEAD_CHARS + VERDICT_TAIL_CHARS) return clean(text.split('\n'));
  const head = text.slice(0, VERDICT_HEAD_CHARS).split('\n');
  head.pop();
  const tail = text.slice(text.length - VERDICT_TAIL_CHARS).split('\n');
  tail.shift();
  return clean([...head, ...tail]);
}

/** How a line starts when a runner or a build tool is saying it failed, as written. Case matters: these are the tools' own capitals. */
export const FAILING_LINE_STARTS: readonly string[] = ['FAIL', 'FAILED', 'FAILURES!', '--- FAIL', 'BUILD FAILED', 'FAILURE:', 'Failed!', 'npm ERR!', 'npm error', 'make: ***'];

/** How a line starts when a runner is saying it passed. */
export const PASSING_LINE_STARTS: readonly string[] = ['PASS', 'PASSED', 'OK', 'BUILD SUCCESSFUL', 'test result: ok'];

/** The words a runner's summary line is made of. A line carrying any other word is prose, or a test's name, and its counts are not a verdict. */
export const SUMMARY_WORDS: ReadonlySet<string> = new Set([
  'test', 'tests', 'suite', 'suites', 'file', 'files', 'spec', 'specs', 'example', 'examples', 'assertions', 'checks', 'snapshots',
  'failed', 'failing', 'failure', 'failures', 'error', 'errors', 'errored',
  'passed', 'passing', 'ok', 'skipped', 'pending', 'todo', 'ignored', 'deselected', 'xfailed', 'xpassed', 'measured', 'filtered', 'out',
  'total', 'ran', 'run', 'found', 'completed', 'finished', 'result', 'time', 'duration', 'elapsed',
  'in', 'of', 'and', 'with', 'warning', 'warnings', 'problem', 'problems', 's', 'ms', 'sec', 'secs', 'seconds', 'min',
]);

const FAIL_COUNT_WORDS: ReadonlySet<string> = new Set(['failed', 'failing', 'failure', 'failures', 'errored']);
const ERROR_COUNT_WORDS: ReadonlySet<string> = new Set(['error', 'errors']);
const PASS_COUNT_WORDS: ReadonlySet<string> = new Set(['passed', 'passing']);

/** Phrases a shell or a harness writes before the exit code of the command it ran. */
export const EXIT_CODE_PHRASES: readonly string[] = ['exit code', 'exit status', 'exited with code', 'exited with status', 'exited with exit code', 'non-zero exit status', 'returned exit code'];

const isDigits = (t: string): boolean => t.length > 0 && t.length <= 9 && /^[0-9]+$/.test(t);
/** `12`, `0`, `52s`, `120ms`: a count or a duration. */
const isCountOrDuration = (t: string): boolean => /^[0-9]+(?:ms|s|m|sec|secs|min)?$/.test(t);

interface Tok {
  text: string;
  start: number;
  end: number;
}

/** The words and numbers of a line, lower-cased, each with where it sits, so what lies BETWEEN two of them can be read. */
function tokensOf(line: string): Tok[] {
  const lower = line.toLowerCase();
  const out: Tok[] = [];
  let i = 0;
  while (i < lower.length) {
    const c = lower[i];
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
      const start = i;
      while (i < lower.length && ((lower[i] >= 'a' && lower[i] <= 'z') || (lower[i] >= '0' && lower[i] <= '9'))) i += 1;
      out.push({ text: lower.slice(start, i), start, end: i });
    } else {
      i += 1;
    }
  }
  return out;
}

/** A line made of counts, durations and summary words, and nothing else. */
function isSummaryLine(tokens: readonly Tok[]): boolean {
  return tokens.length >= 2 && tokens.length <= 40 && tokens.every((t) => isCountOrDuration(t.text) || SUMMARY_WORDS.has(t.text));
}

/**
 * The exit code a line states: the whole number that follows `phrase` and
 * ENDS the line (a full stop or a bracket may close it), or null. "Process
 * exited with code 1" states one. "Exit code 1 means a verdict tripped the
 * gate" is a sentence about exit codes, and states none.
 */
export function exitCodeStated(lower: string, phrase: string): number | null {
  const at = lower.indexOf(phrase);
  if (at === -1) return null;
  let i = at + phrase.length;
  const end = Math.min(lower.length, i + 4);
  while (i < end && (lower[i] === ' ' || lower[i] === ':' || lower[i] === '=')) i += 1;
  let digits = '';
  while (i < lower.length && digits.length < 9 && lower[i] >= '0' && lower[i] <= '9') digits += lower[i++];
  if (digits.length === 0) return null;
  const rest = lower.slice(i).trim();
  return rest === '' || rest === '.' || rest === ')' || rest === ').' ? Number(digits) : null;
}

const startsWithMarker = (line: string, marker: string): boolean => {
  if (!line.startsWith(marker)) return false;
  // `FAIL` and not `FAIL.md` or `FAILOVER`: the marker ends the word.
  const next = line[marker.length];
  return next === undefined || !/[A-Za-z0-9._-]/.test(next);
};

/** Only blanks between two tokens: "3 failed", and not "5, Failures". */
const adjacent = (line: string, a: Tok, b: Tok | undefined): b is Tok => b !== undefined && line.slice(a.end, b.start).trim() === '';
/** A colon or an equals sign between them: "Failures: 2", "failures=3". */
const assigned = (line: string, a: Tok, b: Tok | undefined): b is Tok => {
  if (b === undefined) return false;
  const gap = line.slice(a.end, b.start).trim();
  return gap === ':' || gap === '=';
};
const positive = (t: Tok): boolean => isDigits(t.text) && Number(t.text) > 0;

/** How many of something a summary line counts: "3 failed" (count then word) or "Failures: 3" (word, colon, count). Zero when the line counts none. */
function counted(line: string, tokens: readonly Tok[], words: ReadonlySet<string>): boolean {
  for (let i = 0; i < tokens.length; i += 1) {
    const here = tokens[i];
    const next = tokens[i + 1];
    if (positive(here) && adjacent(line, here, next) && words.has(next.text)) return true;
    if (words.has(here.text) && assigned(line, here, next) && positive(next)) return true;
  }
  return false;
}

function lineFails(line: string): boolean {
  if (FAILING_LINE_STARTS.some((m) => startsWithMarker(line, m))) return true;
  const lower = line.toLowerCase();
  for (const phrase of EXIT_CODE_PHRASES) {
    const code = exitCodeStated(lower, phrase);
    if (code !== null && code !== 0) return true;
  }
  const tokens = tokensOf(line);
  if (!isSummaryLine(tokens)) return false;
  // "3 failed", "Failures: 2", "Found 3 errors in 2 files", "3 problems (3 errors, 0 warnings)"
  return counted(line, tokens, FAIL_COUNT_WORDS) || counted(line, tokens, ERROR_COUNT_WORDS);
}

function linePasses(line: string): boolean {
  if (PASSING_LINE_STARTS.some((m) => startsWithMarker(line, m))) return true;
  const tokens = tokensOf(line);
  return isSummaryLine(tokens) && counted(line, tokens, PASS_COUNT_WORDS);
}

/** The text a command wrote: a string output, or the `stdout` / `output` of an object output. */
function writtenBy(call: ToolCallRecord): string | null {
  const out = call.output;
  if (typeof out === 'string') return out;
  if (out !== null && typeof out === 'object' && !Array.isArray(out)) {
    for (const key of ['stdout', 'output']) {
      const v = (out as Record<string, unknown>)[key];
      if (typeof v === 'string') return v;
    }
  }
  return null;
}

/**
 * The line on which a command's output reports failure, as written, or null.
 *
 * Null for a tool that does not run a command, for an output that is not
 * text, and for text whose head and tail carry no failing verdict.
 */
export function failingVerdict(call: ToolCallRecord): string | null {
  if (!ranACommand(call)) return null;
  const text = writtenBy(call);
  if (text === null) return null;
  return verdictLines(text).find(lineFails) ?? null;
}

/** The line on which a command's output reports that it passed, or null. Never when the same output also reports failure. */
export function passingVerdict(call: ToolCallRecord): string | null {
  if (!ranACommand(call)) return null;
  const text = writtenBy(call);
  if (text === null) return null;
  const lines = verdictLines(text);
  if (lines.some(lineFails)) return null;
  return lines.find(linePasses) ?? null;
}
