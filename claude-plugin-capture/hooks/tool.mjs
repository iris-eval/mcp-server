// PostToolUse and PostToolUseFailure — one call the agent made, and how it
// ended: append it to the turn.
//
// Claude Code fires PostToolUse only for a call that succeeded. A call that
// failed (a command that exited non-zero, a file that was not there, an MCP
// tool that returned an error) fires PostToolUseFailure instead, with the
// error as the call's result. Until this hook listened to both, a failed call
// never reached Iris, so the rule that asks whether an answer owned a failed
// call had nothing to read on the one path that records every turn.
import { appendCall, log, readStdin } from './common.mjs';

try {
  const input = await readStdin();
  const failed = input.hook_event_name === 'PostToolUseFailure';
  const call = {
    tool_name: String(input.tool_name ?? 'unknown'),
    ...(input.tool_input !== undefined ? { input: input.tool_input } : {}),
    ...(typeof input.tool_use_id === 'string' ? { call_id: input.tool_use_id } : {}),
    ...(typeof input.duration_ms === 'number' && Number.isFinite(input.duration_ms) && input.duration_ms >= 0 ? { latency_ms: input.duration_ms } : {}),
  };
  if (failed) {
    // The error string is what Claude received as the call's result. An abort is said as one.
    const error = typeof input.error === 'string' && input.error.trim() !== '' ? input.error : 'the tool call failed';
    appendCall(input.session_id, { ...call, error: input.is_interrupt === true ? `interrupted: ${error}` : error });
  } else {
    // The result field as the host delivers it. tool_response is the documented
    // name; the alternates are read defensively so a rename leaves the call
    // recorded rather than dropped.
    const output = input.tool_response ?? input.tool_output ?? input.tool_result;
    appendCall(input.session_id, { ...call, ...(output !== undefined ? { output } : {}) });
  }
} catch (err) {
  log(`tool hook: ${err instanceof Error ? err.message : String(err)}`);
}
process.exit(0);
