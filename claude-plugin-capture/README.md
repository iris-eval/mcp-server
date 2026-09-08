# iris-eval-capture — record every Claude Code turn into Iris

**Opt-in, and its own plugin.** Installing `iris-eval` never changes your turn loop; installing this one does, and that is the whole point: capture that does not depend on the model deciding to call a tool.

```
/plugin marketplace add iris-eval/mcp-server
/plugin install iris-eval-capture@iris-eval
```

## What it records

Three hooks, one turn: `UserPromptSubmit` remembers the prompt, `PostToolUse` appends each tool call (name, input, response), and `Stop` assembles `{ input, output, tool_calls, run: <session id> }` and hands it to `iris-eval ingest --evaluate --redact critical_spans --source hook`, detached, so your turn never waits on the evaluation. The trace lands in your Iris home (`~/.iris/iris.db`) with its verdict; open the dashboard to read it.

## What it deliberately does not do

- **It never logs a turn twice.** If the model called `log_trace` itself during the turn (the `iris-eval` plugin's instructions ask it to, for answers you will act on), this hook does nothing for that turn. Iris's own tool calls are also filtered out of the recorded trajectory.
- **It never prints.** A Stop hook's stdout becomes context the model sees. Everything this plugin has to say goes to `capture.log` in its data directory.
- **It never blocks.** The ingest runs detached with a ten-second hook timeout as a backstop; a failure is a line in `capture.log`, never a stuck turn.
- **It never sends anything anywhere.** `ingest` is local; nothing leaves the machine unless you have configured Iris to export.

## Named limits

- Only the **final** assistant message of a turn is recorded (`last_assistant_message`); intermediate assistant text is not.
- Tool responses and answers are stored locally and may contain secrets from your own tools. Redaction of critical spans is **on by construction** for this path (`--redact critical_spans`): the text the **evaluation** stores has every span a critical detector flagged replaced by `[REDACTED:<pattern>]`. The **trace** itself keeps the record, as it does on every door — a finding has to point at something — so a turn that must not be retained is removed with `delete_trace` or swept by retention.
- The first run pays `npx`'s cold start to fetch `@iris-eval/mcp-server` at the version this plugin pins; every later run uses the cache.
- A turn with no prompt captured (a resumed session) is still recorded from the answer and the calls.

## Remove it

`/plugin uninstall iris-eval-capture@iris-eval`. Recorded traces stay in your Iris home until retention sweeps them or you `iris-eval --purge`.
