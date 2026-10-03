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
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));

/** Files this plugin writes are readable and writable by their owner only. */
export const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** How long a turn that could not be ingested is kept under pending/ before it is removed. */
export const PENDING_MAX_DAYS = 7;

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
    appendFileSync(join(dataDir(), 'capture.log'), `${new Date().toISOString()} ${line}\n`, { mode: FILE_MODE });
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

function safeId(sessionId) {
  return String(sessionId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
}

/** The turn's header: the prompt, where it ran, when it began. */
function headerPath(sessionId) {
  return join(dataDir(), 'sessions', `${safeId(sessionId)}.json`);
}

/**
 * The turn's calls, one JSON line each. Appended, never rewritten: Claude
 * Code runs independent tool calls in parallel and fires a hook for each,
 * so a read-modify-write of one file lost whichever call finished second.
 */
function callsPath(sessionId) {
  return join(dataDir(), 'sessions', `${safeId(sessionId)}.calls.jsonl`);
}

/** A new turn: its header written, the last turn's calls forgotten. */
export function beginTurn(sessionId, header) {
  writeFileSync(headerPath(sessionId), JSON.stringify(header), { mode: FILE_MODE });
  try {
    unlinkSync(callsPath(sessionId));
  } catch {
    /* no calls yet */
  }
}

export function appendCall(sessionId, call) {
  appendFileSync(callsPath(sessionId), `${JSON.stringify(call)}\n`, { mode: FILE_MODE });
}

/** The turn as recorded so far: its header (when the prompt hook ran) and every call, in the order they finished. */
export function readTurn(sessionId) {
  let header = {};
  try {
    header = JSON.parse(readFileSync(headerPath(sessionId), 'utf8'));
  } catch {
    /* a resumed session: no prompt captured */
  }
  const calls = [];
  if (existsSync(callsPath(sessionId))) {
    for (const line of readFileSync(callsPath(sessionId), 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        calls.push(JSON.parse(line));
      } catch {
        log(`a recorded call could not be read and is left out: ${line.slice(0, 80)}`);
      }
    }
  }
  return { ...header, tool_calls: calls };
}

export function clearTurn(sessionId) {
  for (const p of [headerPath(sessionId), callsPath(sessionId)]) {
    try {
      unlinkSync(p);
    } catch {
      /* already gone */
    }
  }
}

/** The pending/ directory, private like the rest. */
export function pendingDir() {
  return privateDir(join(dataDir(), 'pending'));
}

/** Remove turns that could not be ingested and are older than PENDING_MAX_DAYS. Returns how many were removed. */
export function sweepPending(now = Date.now()) {
  const dir = join(dataDir(), 'pending');
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      if (now - statSync(p).mtimeMs > PENDING_MAX_DAYS * 86_400_000) {
        unlinkSync(p);
        removed += 1;
      }
    } catch {
      /* gone, or not ours to remove */
    }
  }
  return removed;
}

/**
 * Iris's own tools, under either name Claude Code gives them: a server the
 * user configured as "iris-eval" (mcp__iris-eval__log_trace) or the server
 * bundled by the iris-eval plugin (mcp__plugin_iris-eval_iris-eval__log_trace).
 */
export const IRIS_TOOL = /^mcp__(?:plugin_[A-Za-z0-9-]+_)?iris-eval__([a-z_]+)$/;

/** The pinned package version, read from the rendered manifest so a cached plugin cannot outlive a release. */
export function pinnedVersion() {
  try {
    const manifest = JSON.parse(readFileSync(join(here, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}
