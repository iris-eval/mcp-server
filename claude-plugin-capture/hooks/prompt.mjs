// UserPromptSubmit — a turn begins: remember the prompt, forget the last turn's calls.
import { beginTurn, log, readStdin } from './common.mjs';

try {
  const input = await readStdin();
  beginTurn(input.session_id, {
    session_id: input.session_id,
    cwd: input.cwd,
    prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
    started_at: new Date().toISOString(),
  });
} catch (err) {
  log(`prompt hook: ${err instanceof Error ? err.message : String(err)}`);
}
process.exit(0);
