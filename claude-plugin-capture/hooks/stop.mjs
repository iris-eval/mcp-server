// Stop — the turn ended: assemble the trace, write it to a file, and detach
// the ingest runner so the user's turn never waits on the evaluation.
//
// Why a file and a runner, not a pipe (0.13.0 → 0.13.1 of this plugin): the
// first version spawned `npx … ingest` itself, detached, with the trace on a
// stdin pipe and stderr on another, and exited a millisecond later — and on
// the published package the ingest died with those pipes, so no turn was
// ever recorded. Measured by the stranger harness's capture phase, which
// passed only when the hook was made to wait. A detached child must own
// nothing of the process that spawned it: the payload lives in a file, and
// hooks/ingest-runner.mjs is started with every stdio ignored.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IRIS_TOOL, clearSession, dataDir, here, log, readSession, readStdin } from './common.mjs';

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
  // The payload goes to a file under the plugin's data directory; the runner
  // removes it once the ingest has stored the turn, and leaves it in place
  // when it could not (the evidence, and the retry).
  const pending = join(dataDir(), 'pending');
  mkdirSync(pending, { recursive: true });
  const file = join(pending, `${Date.now()}-${process.pid}.json`);
  writeFileSync(file, JSON.stringify(built.trace));
  const runner = join(here, 'ingest-runner.mjs');
  if (process.env.IRIS_CAPTURE_WAIT === '1') {
    // Tests (and a host that reaps detached children) wait for the outcome.
    const r = spawnSync(process.execPath, [runner, file], { stdio: 'ignore', windowsHide: true });
    if (r.status !== 0) log(`stop hook: the ingest runner exited ${r.status ?? r.error?.message ?? '?'}`);
  } else {
    // Fire and forget: no pipe, no shell, nothing of this process for the
    // runner to lose when it exits a moment from now.
    spawn(process.execPath, [runner, file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
} catch (err) {
  log(`stop hook: ${err instanceof Error ? err.message : String(err)}`);
}
