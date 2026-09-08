// Shared by the three capture hooks. No dependencies, no stdout: a Stop
// hook's stdout becomes context the model sees, so every message goes to
// the capture log under the plugin's data directory.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));

/** ${CLAUDE_PLUGIN_DATA} is the plugin's writable, update-surviving directory; a scratch dir stands in when a host does not set it. */
export function dataDir() {
  const d = process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'iris-eval-capture');
  mkdirSync(join(d, 'sessions'), { recursive: true });
  return d;
}

export function log(line) {
  try {
    appendFileSync(join(dataDir(), 'capture.log'), `${new Date().toISOString()} ${line}\n`);
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

function sessionPath(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return join(dataDir(), 'sessions', `${safe}.json`);
}

export function readSession(sessionId) {
  const p = sessionPath(sessionId);
  if (!existsSync(p)) return { session_id: sessionId, tool_calls: [] };
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return { session_id: sessionId, tool_calls: [] };
  }
}

export function writeSession(sessionId, session) {
  writeFileSync(sessionPath(sessionId), JSON.stringify(session));
}

export function clearSession(sessionId) {
  try {
    unlinkSync(sessionPath(sessionId));
  } catch {
    /* already gone */
  }
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
