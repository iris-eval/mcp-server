// Shared by the capture hooks. No dependencies, no stdout: a Stop hook's
// stdout becomes context the model sees, so every message goes to the
// capture log under the plugin's data directory.
//
// What this plugin holds is the text of your turns: the prompt, every tool
// call's input and output, the answer. So it is held like a secret. The data
// directory is the host's per-plugin directory or, when the host sets none,
// one under your own Iris home, never a shared temporary directory another
// user could create first; it is made readable by you alone, and so is every
// file in it.
//
// A TURN is one prompt and what followed it, keyed on the prompt's id
// (`prompt_id`, which Claude Code sends on every hook from 2.1.196). Keying on
// the session instead lost calls: a new prompt cleared the session's calls,
// and Claude Code fires a prompt hook when a background sub-agent reports back
// and fires no Stop when you interrupt a turn, so an interrupted turn's calls
// and a background sub-agent's were thrown away or landed in the next turn.
// Now nothing is deleted before it is sent: calls a turn has not sent go to
// Iris as their own part of that turn when the next prompt arrives.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

export const here = dirname(fileURLToPath(import.meta.url));

/** Files this plugin writes are readable and writable by their owner only. */
export const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** How long a turn that could not be ingested is kept under pending/ before it is removed. */
export const PENDING_MAX_DAYS = 7;
/** A session untouched this long is closed: what it has not sent is sent, and its files are removed. */
export const STALE_SESSION_HOURS = 24;
/** The capture log is rotated past this size, one previous file kept. */
export const LOG_MAX_BYTES = 1_048_576;
/** A tool call's output or error longer than this is kept as its head and its tail, marked truncated: a hook must finish well inside its timeout. */
export const FIELD_MAX_CHARS = 262_144;
/** How this plugin names itself on the traces it records (the trace's `capture.name`). */
export const CAPTURE_NAME = 'iris-eval-capture';
/** A turn that failed to ingest is retried when it is at least this old, so a retry never races the first attempt. */
export const RETRY_AFTER_MS = 10 * 60_000;
/** At most this many failed turns are retried by one Stop. */
export const RETRY_MAX = 3;

function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(path, DIR_MODE);
  } catch {
    /* a host or a file system without POSIX modes keeps its own rules */
  }
  return path;
}

/** ${CLAUDE_PLUGIN_DATA} is the plugin's writable, update-surviving directory; without it, capture/ in the Iris home (IRIS_HOME, or ~/.iris). */
export function dataDir() {
  const base = process.env.CLAUDE_PLUGIN_DATA || join(process.env.IRIS_HOME || join(homedir(), '.iris'), 'capture');
  privateDir(base);
  privateDir(join(base, 'sessions'));
  return base;
}

export function log(line) {
  try {
    const path = join(dataDir(), 'capture.log');
    try {
      if (statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {
      /* no log yet */
    }
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, { mode: FILE_MODE });
  } catch {
    /* a log that cannot be written must not fail a hook */
  }
}

export async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

function safeId(id) {
  return String(id || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
}

function sessionDir(sessionId) {
  return privateDir(join(dataDir(), 'sessions', safeId(sessionId)));
}

const turnFile = (sessionId, key) => join(sessionDir(sessionId), `${key}.turn.json`);
const callsFile = (sessionId, key) => join(sessionDir(sessionId), `${key}.calls.jsonl`);
const sentFile = (sessionId, key) => join(sessionDir(sessionId), `${key}.sent.json`);
const currentFile = (sessionId) => join(sessionDir(sessionId), 'current');

/**
 * The turn an event belongs to: its prompt id, or, from a Claude Code too old
 * to send one, the turn the session's last prompt began.
 */
export function turnKeyOf(input) {
  if (typeof input.prompt_id === 'string' && input.prompt_id !== '') return safeId(input.prompt_id);
  try {
    return readFileSync(currentFile(input.session_id), 'utf8').trim() || 'unprompted';
  } catch {
    return 'unprompted';
  }
}

/** A prompt: its turn's header, written once. Without a prompt id, the turn gets one of its own and becomes the session's current turn. */
export function beginTurn(input) {
  const real = typeof input.prompt_id === 'string' && input.prompt_id !== '';
  const key = real ? safeId(input.prompt_id) : `t${Date.now()}-${process.pid}`;
  if (!real) writeFileSync(currentFile(input.session_id), key, { mode: FILE_MODE });
  const path = turnFile(input.session_id, key);
  if (!existsSync(path)) {
    const header = {
      cwd: input.cwd,
      prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
      started_at: new Date().toISOString(),
      ...(real ? { prompt_id: input.prompt_id } : {}),
    };
    writeFileSync(path, JSON.stringify(header), { mode: FILE_MODE });
  }
  return key;
}

/** A string kept whole up to FIELD_MAX_CHARS, else as its head and its tail with what was left out said between them. */
function capped(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined || text.length <= FIELD_MAX_CHARS) return { value, truncated: false };
  const half = FIELD_MAX_CHARS / 2;
  const left = text.length - FIELD_MAX_CHARS;
  return { value: `${text.slice(0, half)}\n… [${left} characters left out by the capture plugin] …\n${text.slice(-half)}`, truncated: true };
}

/** A call's output and error, each capped; `truncated` set when either was. */
export function cappedCall(call) {
  let truncated = false;
  const out = { ...call };
  for (const field of ['output', 'error']) {
    if (out[field] === undefined) continue;
    const c = capped(out[field]);
    out[field] = c.value;
    truncated ||= c.truncated;
  }
  return truncated ? { ...out, truncated: true } : out;
}

/**
 * One call, appended as its own line. Each record starts on a fresh line, so a
 * hook killed half way through its write leaves one unreadable line, not one
 * that swallows the next call too.
 */
export function appendCall(sessionId, key, call) {
  appendFileSync(callsFile(sessionId, key), `\n${JSON.stringify(call)}\n`, { mode: FILE_MODE });
}

/**
 * A turn as recorded: its header (when its prompt was seen), every call in the
 * order they finished, how much of it was sent, and how many calls it lost (a
 * line a killed hook left unreadable, or a hook that failed and said so).
 */
export function readTurn(sessionId, key, path = callsFile(sessionId, key)) {
  let header = null;
  try {
    header = JSON.parse(readFileSync(turnFile(sessionId, key), 'utf8'));
  } catch {
    /* a resumed session, or a part that outlived its prompt's header */
  }
  const calls = [];
  let lost = 0;
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        lost += 1;
        log(`a recorded call could not be read and is left out: ${line.slice(0, 80)}`);
        continue;
      }
      if (record && record.lost === true) lost += 1;
      else calls.push(record);
    }
  }
  let sent = { parts: 0, calls: 0, stopped: false };
  try {
    sent = { ...sent, ...JSON.parse(readFileSync(sentFile(sessionId, key), 'utf8')) };
  } catch {
    /* nothing sent yet */
  }
  return { header, calls, sent, lost };
}

/** Marks a call this turn lost: its hook failed before the call was recorded. Read by readTurn, so the turn's list is never declared whole. */
export function markLost(sessionId, key) {
  appendFileSync(callsFile(sessionId, key), `\n${JSON.stringify({ lost: true })}\n`, { mode: FILE_MODE });
}

export function markSent(sessionId, key, sent) {
  writeFileSync(sentFile(sessionId, key), JSON.stringify(sent), { mode: FILE_MODE });
}

function removeTurn(sessionId, key) {
  for (const p of [turnFile(sessionId, key), callsFile(sessionId, key), sentFile(sessionId, key)]) {
    try {
      unlinkSync(p);
    } catch {
      /* already gone */
    }
  }
}

/** The turn keys a session holds, from its file names. */
function turnKeys(dir) {
  const keys = new Set();
  for (const name of readdirSync(dir)) {
    const m = /^(.+)\.(?:turn|calls|sent)\.jsonl?$/.exec(name);
    if (m) keys.add(m[1]);
  }
  return [...keys];
}

/**
 * Iris's own tools, under any name Claude Code gives them: a server the user
 * configured as "iris-eval" (mcp__iris-eval__log_trace), the name an earlier
 * Iris installer wrote ("iris"), or the server bundled by the iris-eval
 * plugin (mcp__plugin_iris-eval_iris-eval__log_trace).
 */
export const IRIS_TOOL = /^mcp__(?:plugin_[A-Za-z0-9-]+_)?(?:iris-eval|iris)__([a-z_]+)$/;

/** The trace ids a successful log_trace call answered with, each once. */
function loggedTraceIds(call) {
  const out = call.output;
  const structured = out && typeof out === 'object' ? (out.structuredContent ?? out) : null;
  if (structured && typeof structured.trace_id === 'string') return [structured.trace_id];
  const text = typeof out === 'string' ? out : JSON.stringify(out ?? '');
  return [...new Set([...text.matchAll(/trace_id\\?["']?\s*:\s*\\?["']([0-9a-f]{32})/g)].map((m) => m[1]))];
}

/**
 * A trace for some of a turn's calls. `how` says which part it is:
 *   answered   the turn's end (Stop): the answer, and the calls it can be judged against
 *   continued  a later end of the same turn, after a Stop hook kept it going
 *   failed     the turn ended in an API error (StopFailure): no answer, and not judged
 *   unfinished calls the turn made that no end sent: it was interrupted, or the
 *              calls came after it ended (a background sub-agent); not judged
 * Returns null when there is nothing to send.
 */
export function assemble({ sessionId, key, header, calls, sent, how, output, input = {}, lost = 0 }) {
  const fresh = calls.slice(sent.calls);
  const own = fresh.filter((c) => IRIS_TOOL.exec(c.tool_name)?.[1] === 'log_trace');
  const logged = own.filter((c) => c.error === undefined);
  const ids = [...new Set(logged.flatMap(loggedTraceIds))];
  const tool_calls = fresh.filter((c) => !IRIS_TOOL.test(c.tool_name)).map(({ agent, ...c }) => c);
  const subagent = fresh.filter((c) => c.agent && !IRIS_TOOL.test(c.tool_name)).map((c) => ({ ...(c.call_id ? { call_id: c.call_id } : {}), tool_name: c.tool_name, ...c.agent }));
  const answered = how === 'answered' || how === 'continued';
  if (!answered && how !== 'failed' && tool_calls.length === 0) return null;
  if (answered && !output && tool_calls.length === 0) return null;
  /*
   * An empty list says no call was made, and Iris reads it so. It is sent only
   * when the record is known whole: the turn's prompt was seen, it ended with
   * Stop on its first end, nothing was left running in the background, no
   * call was lost (an unreadable line, a hook that failed), and the list
   * leaves none out (Iris's own tools are not in it, so a turn that called
   * one does not have its every call in the list). Otherwise a turn with no
   * recorded call sends no list, which says nothing either way.
   */
  const leftOut = fresh.some((c) => IRIS_TOOL.test(c.tool_name));
  const whole = how === 'answered' && header !== null && sent.parts === 0 && Array.isArray(input.background_tasks) && input.background_tasks.length === 0 && lost === 0 && !leftOut;
  const part = sent.parts + 1;
  /*
   * What this record holds in full, declared to Iris (its trace `capture`):
   * the prompt when it was seen and has text, every tool call when the record
   * is whole (Iris's own tools are left out of the list, as above), and every
   * call's output or error when each recorded call has one. Iris then reads
   * the empty list as "no tool was called", and a field declared here that
   * the trace lacks as a hole in the record. Only what this part holds is
   * declared, so the declaration is never false: a result cut to its head
   * and tail is not one recorded in full.
   */
  const complete = [
    ...(typeof header?.prompt === 'string' && header.prompt.trim() !== '' ? ['input'] : []),
    ...(whole ? ['tool_calls'] : []),
    ...(lost === 0 && tool_calls.every((c) => (c.output !== undefined || c.error !== undefined) && c.truncated !== true) ? ['tool_outputs'] : []),
  ];
  const version = pinnedVersion();
  return {
    evaluate: answered,
    trace: {
      agent_name: 'claude-code',
      framework: 'claude-code',
      ...(header?.prompt !== undefined ? { input: header.prompt } : {}),
      ...(answered ? { output } : { output: '' }),
      ...(tool_calls.length > 0 || whole ? { tool_calls } : {}),
      run: String(sessionId ?? 'unknown'),
      capture: { name: CAPTURE_NAME, ...(version ? { version } : {}), ...(complete.length > 0 ? { complete } : {}) },
      metadata: {
        session_id: sessionId,
        cwd: input.cwd ?? header?.cwd,
        turn: { ...(header?.prompt_id ? { prompt_id: header.prompt_id } : { key }), part, ended: how },
        ...(subagent.length > 0 ? { subagent_calls: subagent } : {}),
        ...(own.length > 0 ? { model_logged: { calls: logged.length, trace_ids: ids, ...(own.length > logged.length ? { failed: own.length - logged.length } : {}) } } : {}),
        ...(how === 'failed' ? { stop_failure: { error: String(input.error ?? 'unknown'), ...(input.error_details !== undefined ? { details: input.error_details } : {}) } } : {}),
      },
      timestamp: new Date().toISOString(),
    },
    sentAfter: { parts: part, calls: calls.length, stopped: sent.stopped || how !== 'unfinished' },
  };
}

/** The pending/ directory, private like the rest. */
export function pendingDir() {
  return privateDir(join(dataDir(), 'pending'));
}

/**
 * Hand a built part to the ingest runner: written to pending/, then the runner
 * detached (or waited for, under IRIS_CAPTURE_WAIT) with any older failed
 * turns to retry. A part that is not judged says so in its file name.
 */
export function send(built, retry = []) {
  const file = join(pendingDir(), `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}${built.evaluate ? '' : '.noeval'}.json`);
  writeFileSync(file, JSON.stringify(built.trace), { mode: FILE_MODE });
  const runner = join(here, 'ingest-runner.mjs');
  const files = [file, ...retry];
  if (process.env.IRIS_CAPTURE_WAIT === '1') {
    const r = spawnSync(process.execPath, [runner, ...files], { stdio: 'ignore', windowsHide: true });
    if (r.status !== 0) log(`the ingest runner exited ${r.status ?? r.error?.message ?? '?'}`);
  } else {
    // Fire and forget: no pipe, no shell, nothing of this process for the runner to lose when it exits a moment from now.
    spawn(process.execPath, [runner, ...files], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
  return file;
}

/** Older failed turns to retry, oldest first, never one a runner may still hold. */
export function retryable(now = Date.now()) {
  const dir = join(dataDir(), 'pending');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => ({ path: join(dir, n), mtime: statSync(join(dir, n)).mtimeMs }))
    .filter((f) => now - f.mtime >= RETRY_AFTER_MS)
    .sort((a, b) => a.mtime - b.mtime)
    .slice(0, RETRY_MAX)
    .map((f) => f.path);
}

/**
 * Every unsent call of one turn as an `unfinished` part, then the turn's files
 * removed. The calls file is moved aside before it is read, so a call a tool
 * hook appends meanwhile starts a new file, sent by a later sweep, instead of
 * being deleted unread.
 */
export function flushTurn(sessionId, key, dryRun = []) {
  const path = callsFile(sessionId, key);
  const moving = `${path}.${process.pid}.flushing`;
  let moved = false;
  try {
    renameSync(path, moving);
    moved = true;
  } catch {
    /* no calls file */
  }
  const { header, calls, sent, lost } = readTurn(sessionId, key, moved ? moving : path);
  const built = assemble({ sessionId, key, header, calls, sent, how: 'unfinished', lost });
  if (built) {
    if (process.env.IRIS_CAPTURE_DRY_RUN === '1') dryRun.push(built);
    else send(built);
  }
  removeTurn(sessionId, key);
  if (moved) {
    try {
      unlinkSync(moving);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Close what is done: when `keep` is given (a new prompt), every other turn of
 * this session; in the other sessions, every one untouched for
 * STALE_SESSION_HOURS. Calls not yet sent are sent first. Then failed turns
 * past PENDING_MAX_DAYS are removed. Returns the parts a dry run would have
 * sent.
 */
export function sweep({ sessionId, keep, now = Date.now() }) {
  const dryRun = [];
  const root = join(dataDir(), 'sessions');
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) {
      // A file left by an earlier version of this plugin, which kept one per session: removed once it is a day old.
      if (now - st.mtimeMs > STALE_SESSION_HOURS * 3_600_000) rmSync(dir, { force: true });
      continue;
    }
    const mine = name === safeId(sessionId);
    if (mine) {
      if (keep !== undefined) for (const key of turnKeys(dir)) if (key !== keep) flushTurn(name, key, dryRun);
      continue;
    }
    const newest = Math.max(st.mtimeMs, ...readdirSync(dir).map((n) => statSync(join(dir, n)).mtimeMs));
    if (now - newest < STALE_SESSION_HOURS * 3_600_000) continue;
    for (const key of turnKeys(dir)) flushTurn(name, key, dryRun);
    rmSync(dir, { recursive: true, force: true });
  }
  const pending = join(dataDir(), 'pending');
  if (existsSync(pending)) {
    for (const name of readdirSync(pending)) {
      const p = join(pending, name);
      try {
        if (now - statSync(p).mtimeMs > PENDING_MAX_DAYS * 86_400_000) unlinkSync(p);
      } catch {
        /* gone, or not ours to remove */
      }
    }
  }
  return dryRun;
}

/** The pinned package version, read from the rendered manifest so a cached plugin cannot outlive a release. */
export function pinnedVersion() {
  try {
    const manifest = JSON.parse(readFileSync(join(here, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}
