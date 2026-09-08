// Stop — the turn ended: assemble the trace and hand it to `iris-eval ingest`,
// detached, so the user's turn never waits on the evaluation.
import { spawn } from 'node:child_process';
import { IRIS_TOOL, clearSession, log, pinnedVersion, readSession, readStdin } from './common.mjs';

const INGEST_ARGS = ['ingest', '--evaluate', '--redact', 'critical_spans', '--source', 'hook'];

function assemble(input, session) {
  const calls = Array.isArray(session.tool_calls) ? session.tool_calls : [];
  // The hook and the model must not both log one turn: if the model already
  // called log_trace this turn, the trace exists and this hook does nothing.
  if (calls.some((c) => IRIS_TOOL.exec(c.tool_name)?.[1] === 'log_trace')) return { skipped: 'the model logged this turn itself' };
  // Iris evaluating its own calls to itself is not the trajectory anyone
  // wants judged.
  const tool_calls = calls.filter((c) => !IRIS_TOOL.test(c.tool_name));
  const output = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : undefined;
  if (!output && tool_calls.length === 0) return { skipped: 'nothing to record' };
  return {
    trace: {
      agent_name: 'claude-code',
      framework: 'claude-code',
      ...(session.prompt !== undefined ? { input: session.prompt } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(tool_calls.length > 0 ? { tool_calls } : {}),
      run: String(input.session_id ?? session.session_id ?? 'unknown'),
      metadata: { session_id: input.session_id, cwd: input.cwd ?? session.cwd, captured_by: 'iris-eval-capture' },
      timestamp: new Date().toISOString(),
    },
  };
}

function ingestCommand() {
  // Tests point this at the repo's own entry point (a JSON argv, so a path
  // with a space survives); users get the published package.
  const override = process.env.IRIS_CAPTURE_INGEST_ARGV;
  if (override) {
    const parts = JSON.parse(override);
    return [{ cmd: parts[0], args: [...parts.slice(1), ...INGEST_ARGS], shell: false }];
  }
  const version = pinnedVersion();
  // On Windows npx is a .cmd shim, which Node refuses to spawn without a
  // shell. Every argument here is our own literal or the pinned version.
  const shell = process.platform === 'win32';
  return [
    { cmd: 'npx', args: ['--no-install', '@iris-eval/mcp-server', ...INGEST_ARGS], shell },
    { cmd: 'npx', args: ['-y', version ? `@iris-eval/mcp-server@${version}` : '@iris-eval/mcp-server', ...INGEST_ARGS], shell },
  ];
}

function run(candidate, payload) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(candidate.cmd, candidate.args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true, shell: candidate.shell, detached: process.env.IRIS_CAPTURE_WAIT !== '1' });
    } catch (err) {
      resolve({ ok: false, why: err instanceof Error ? err.message : String(err) });
      return;
    }
    let stderr = '';
    child.stderr?.on('data', (c) => { stderr += c.toString(); });
    child.once('error', (err) => resolve({ ok: false, why: err.message }));
    child.once('close', (code) => resolve({ ok: code === 0 || code === 1, code, why: stderr.trim() }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
    if (process.env.IRIS_CAPTURE_WAIT !== '1') child.unref();
  });
}

try {
  const input = await readStdin();
  const session = readSession(input.session_id);
  const built = assemble(input, session);
  clearSession(input.session_id);
  if (process.env.IRIS_CAPTURE_DRY_RUN === '1') {
    // The test seam: print what would be sent, send nothing.
    process.stdout.write(JSON.stringify(built) + '\n');
    process.exit(0);
  }
  if (built.skipped) {
    log(`stop hook: skipped — ${built.skipped}`);
    process.exit(0);
  }
  // Fire and forget by default: the user's turn never waits on the evaluation.
  // A failed first candidate (no cached package) falls through to the pinned install.
  const candidates = ingestCommand();
  if (process.env.IRIS_CAPTURE_WAIT === '1') {
    let last;
    for (const candidate of candidates) {
      last = await run(candidate, built.trace);
      if (last.ok) break;
    }
    if (!last?.ok) log(`stop hook: ingest failed — ${last?.why ?? 'unknown'}`);
  } else {
    void run(candidates[0], built.trace).then((r) => {
      if (!r.ok && candidates[1]) return run(candidates[1], built.trace).then((r2) => { if (!r2.ok) log(`stop hook: ingest failed — ${r2.why}`); });
    });
  }
} catch (err) {
  log(`stop hook: ${err instanceof Error ? err.message : String(err)}`);
}
process.exit(0);
