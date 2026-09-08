// UserPromptSubmit — a turn begins: remember the prompt, forget the last turn's calls.
import { log, readStdin, writeSession } from './common.mjs';

try {
  const input = await readStdin();
  writeSession(input.session_id, {
    session_id: input.session_id,
    cwd: input.cwd,
    prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
    started_at: new Date().toISOString(),
    tool_calls: [],
  });
} catch (err) {
  log(`prompt hook: ${err instanceof Error ? err.message : String(err)}`);
}
process.exit(0);
