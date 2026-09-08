// PostToolUse — one call the agent made: append it to the turn.
import { log, readSession, readStdin, writeSession } from './common.mjs';

try {
  const input = await readStdin();
  const session = readSession(input.session_id);
  // The result field as the host delivers it. tool_response is the documented
  // name; the alternates are read defensively so a rename leaves the call
  // recorded rather than dropped.
  const output = input.tool_response ?? input.tool_output ?? input.tool_result;
  session.tool_calls.push({
    tool_name: String(input.tool_name ?? 'unknown'),
    ...(input.tool_input !== undefined ? { input: input.tool_input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(typeof input.tool_use_id === 'string' ? { call_id: input.tool_use_id } : {}),
  });
  writeSession(input.session_id, session);
} catch (err) {
  log(`tool hook: ${err instanceof Error ? err.message : String(err)}`);
}
process.exit(0);
