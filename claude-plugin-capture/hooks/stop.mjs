// Stop and StopFailure — the turn ended: assemble the trace, write it to a
// file, and detach the ingest runner so the user's turn never waits on the
// evaluation.
//
// Why a file and a runner, not a pipe (0.13.0 → 0.13.1 of this plugin): the
// first version spawned `npx … ingest` itself, detached, with the trace on a
// stdin pipe and stderr on another, and exited a millisecond later — and on
// the published package the ingest died with those pipes, so no turn was
// ever recorded. Measured by the stranger harness's capture phase, which
// passed only when the hook was made to wait. A detached child must own
// nothing of the process that spawned it: the payload lives in a file, and
// hooks/ingest-runner.mjs is started with every stdio ignored.
//
// A turn that ends in an API error (a rate limit, an overloaded model, a
// failed credential) fires StopFailure instead of Stop. It is recorded too,
// with the error, because a turn that never finished is the turn a reader
// most needs to see.
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILE_MODE, IRIS_TOOL, clearTurn, here, log, pendingDir, readStdin, readTurn, sweepPending } from './common.mjs';

/** The trace ids a log_trace call answered with, read from its result as the host delivered it. */
function loggedTraceIds(call) {
  const text = typeof call.output === 'string' ? call.output : JSON.stringify(call.output ?? '');
  return [...text.matchAll(/trace_id\\?["']?\s*:\s*\\?["']([0-9a-f]{32})/g)].map((m) => m[1]);
}

function assemble(input, turn) {
  const calls = Array.isArray(turn.tool_calls) ? turn.tool_calls : [];
  /*
   * The model may log the same turn itself (the iris-eval plugin asks it to
   * for answers you will act on). This hook used to drop its own record then,
   * so the turn's only trace was the model's account of it, which can leave
   * out the call that failed. Both are kept now: this one is what the host
   * saw, and it names the trace the model logged.
   */
  const ownCalls = calls.filter((c) => IRIS_TOOL.exec(c.tool_name)?.[1] === 'log_trace');
  const modelLogged = ownCalls.length > 0 ? { model_logged: { calls: ownCalls.length, trace_ids: ownCalls.flatMap(loggedTraceIds) } } : {};
  // Iris evaluating its own calls to itself is not the trajectory anyone wants judged.
  const tool_calls = calls.filter((c) => !IRIS_TOOL.test(c.tool_name));
  const failure = input.hook_event_name === 'StopFailure';
  const output = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : undefined;
  if (!output && tool_calls.length === 0 && !failure) return { skipped: 'nothing to record' };
  return {
    trace: {
      agent_name: 'claude-code',
      framework: 'claude-code',
      ...(turn.prompt !== undefined ? { input: turn.prompt } : {}),
      ...(output !== undefined ? { output } : failure ? { output: '' } : {}),
      // Always sent, even empty: the host saw every call of the turn, so an empty list says none was made.
      tool_calls,
      run: String(input.session_id ?? turn.session_id ?? 'unknown'),
      metadata: {
        session_id: input.session_id,
        cwd: input.cwd ?? turn.cwd,
        captured_by: 'iris-eval-capture',
        ...modelLogged,
        ...(failure ? { stop_failure: { error: String(input.error ?? 'unknown'), ...(input.error_details !== undefined ? { details: input.error_details } : {}) } } : {}),
      },
      timestamp: new Date().toISOString(),
    },
  };
}

try {
  const input = await readStdin();
  const built = assemble(input, readTurn(input.session_id));
  clearTurn(input.session_id);
  if (process.env.IRIS_CAPTURE_DRY_RUN === '1') {
    // The test seam: print what would be sent, send nothing.
    process.stdout.write(JSON.stringify(built) + '\n');
    process.exit(0);
  }
  const swept = sweepPending();
  if (swept > 0) log(`stop hook: removed ${swept} turn(s) older than the pending limit`);
  if (built.skipped) {
    log(`stop hook: skipped — ${built.skipped}`);
    process.exit(0);
  }
  // The payload goes to a file under the plugin's data directory, readable by
  // you alone; the runner removes it once the ingest has stored the turn, and
  // leaves it in place when it could not (the evidence, and the retry) until
  // the pending limit.
  const file = join(pendingDir(), `${Date.now()}-${process.pid}.json`);
  writeFileSync(file, JSON.stringify(built.trace), { mode: FILE_MODE });
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
