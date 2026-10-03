// UserPromptSubmit — a turn begins. Its prompt is written down, and what the
// session's earlier turns did not send is sent now, as their own parts: an
// interrupted turn's calls (Claude Code fires no Stop on an interrupt) and a
// background sub-agent's calls made after its turn ended. Claude Code also
// fires this hook when a background sub-agent reports back, a scheduled task
// fires, or another session sends a message; each of those begins a turn of
// its own.
import { beginTurn, log, readStdin, sweep } from './common.mjs';

try {
  const input = await readStdin();
  const key = beginTurn(input);
  const dry = sweep({ sessionId: input.session_id, keep: key });
  // The test seam prints the parts the sweep would have sent; a real prompt hook prints nothing.
  if (process.env.IRIS_CAPTURE_DRY_RUN === '1' && dry.length > 0) process.stdout.write(JSON.stringify(dry) + '\n');
} catch (err) {
  log(`prompt hook: ${err instanceof Error ? err.message : String(err)}`);
}
process.exit(0);
