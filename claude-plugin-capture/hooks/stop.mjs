// Stop and StopFailure — a turn ended: assemble what it has not sent, write
// it to a file, and detach the ingest runner so the user's turn never waits on
// the evaluation.
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
// Three kinds of end:
//   - Stop: the answer, and the calls it can be judged against.
//   - Stop again for the same prompt: a Stop hook (such as /goal) kept the turn
//     going. The calls since the first end go as the turn's next part, with the
//     answer it ended on this time; every part carries the prompt's id.
//   - StopFailure: an API error (a rate limit, an overloaded model, a failed
//     credential) ended the turn. Its calls are recorded with the error; there
//     is no answer, so the part is stored without being judged, rather than
//     judged on the error text.
// The turn's files stay until the next prompt, so a later part can still find
// what was sent before it.
import { assemble, log, markSent, readStdin, readTurn, retryable, send, sweep, turnKeyOf } from './common.mjs';

try {
  const input = await readStdin();
  const key = turnKeyOf(input);
  const { header, calls, sent } = readTurn(input.session_id, key);
  const how = input.hook_event_name === 'StopFailure' ? 'failed' : sent.stopped || input.stop_hook_active === true ? 'continued' : 'answered';
  const output = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : undefined;
  const built = assemble({ sessionId: input.session_id, key, header, calls, sent, how, output, input });
  if (process.env.IRIS_CAPTURE_DRY_RUN === '1') {
    // The test seam: print what would be sent, send nothing. The process ends
    // when the write has drained: on a pipe, POSIX stdout is asynchronous, and
    // an exit right after a large write cuts it off.
    if (built) markSent(input.session_id, key, built.sentAfter);
    process.stdout.write(JSON.stringify(built ? { trace: built.trace, evaluate: built.evaluate } : { skipped: 'nothing to record' }) + '\n');
  } else {
    sweep({ sessionId: input.session_id });
    if (!built) {
      log('stop hook: skipped — nothing to record');
    } else {
      markSent(input.session_id, key, built.sentAfter);
      // Turns an earlier runner could not ingest ride along, a few at a time.
      send(built, retryable());
    }
  }
} catch (err) {
  log(`stop hook: ${err instanceof Error ? err.message : String(err)}`);
}
