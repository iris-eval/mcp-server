# iris-eval-capture — record every Claude Code turn into Iris

**Opt-in, and its own plugin.** Installing `iris-eval` never changes your turn loop; installing this one does, and that is the whole point: capture that does not depend on the model deciding to call a tool.

```
/plugin marketplace add iris-eval/mcp-server
/plugin install iris-eval-capture@iris-eval
```

## What it records

One turn, from five hook events:

| Event | What it adds |
|---|---|
| `UserPromptSubmit` | the prompt |
| `PostToolUse` | each tool call that succeeded: name, input, result, how long it took |
| `PostToolUseFailure` | each tool call that failed: name, input, and the error the agent received (a command's `Exit code 1` and its output, a missing file, an MCP tool's error); an aborted call is recorded as `interrupted: …` |
| `Stop` | the final answer, and hands the turn to Iris |
| `StopFailure` | a turn that ended in an API error (a rate limit, an overloaded model, a failed credential), recorded with the error |

The turn is assembled as `{ input, output, tool_calls, run: <session id> }` and handed to `iris-eval ingest --evaluate --redact critical_spans --source hook`, detached, so your turn never waits on the evaluation. The trace lands in your Iris home (`~/.iris/iris.db`) with its verdict; open the dashboard to read it.

`tool_calls` is always sent, empty when no tool was called: the host saw every call of the turn, so an empty list is a statement that none was made, and Iris's rules read it that way.

## What it deliberately does not do

- **It never lets the model's account replace its own.** If the model called `log_trace` itself during the turn (the `iris-eval` plugin's instructions ask it to, for answers you will act on), both traces are kept: the model's, and this hook's record of what the host saw, which names the model's trace in `metadata.model_logged.trace_ids`. Until 0.20.0 the hook stood down instead, so the turn's only trace was the model's account of it, which can leave out the call that failed. Iris's own tool calls are filtered out of the recorded trajectory.
- **It never prints.** A Stop hook's stdout becomes context the model sees. Everything this plugin has to say goes to `capture.log` in its data directory.
- **It never blocks.** The Stop hook writes the turn to a file under the plugin's data directory (`pending/`) and detaches a small runner that hands the file to `iris-eval ingest` and exits; the hook itself returns in a few milliseconds. A turn the runner could not ingest stays in `pending/` with the reason in `capture.log` for seven days, then is removed. (`IRIS_CAPTURE_WAIT=1` makes the hook wait for the runner instead, for tests and for hosts that reap detached children.)
- **It never sends anything anywhere.** `ingest` is local; nothing leaves the machine unless you have configured Iris to export.

## Where it keeps what it holds

What this plugin holds is the text of your turns, so it is kept like a secret:

- In the directory Claude Code gives the plugin (`CLAUDE_PLUGIN_DATA`), or, when a host sets none, in `capture/` inside your Iris home (`IRIS_HOME`, or `~/.iris`). Never in a shared temporary directory another user could create first.
- Directories readable by you alone (`0700`), files by you alone (`0600`), on systems with POSIX permissions.
- A turn's calls are appended one line each as they finish, so calls the host runs in parallel are all kept.
- Both ingest attempts run the version this plugin pins, from `npx`'s cache first and then by installing it.

## Named limits

- Only the **final** assistant message of a turn is recorded (`last_assistant_message`); intermediate assistant text is not.
- A call Claude Code rejects before it runs (an unknown tool, input that fails validation, a permission denial) fires no hook and is not recorded.
- A sub-agent's tool calls are recorded in the turn that started it, without saying which sub-agent made them.
- Tool responses and answers are stored locally and may contain secrets from your own tools. Redaction of critical spans is **on by construction** for this path (`--redact critical_spans`): the text the **evaluation** stores has every span a critical detector flagged replaced by `[REDACTED:<pattern>]`. The **trace** itself keeps the record, as it does on every door — a finding has to point at something — so a turn that must not be retained is removed with `delete_trace` or swept by retention.
- The first run pays `npx`'s cold start to fetch `@iris-eval/mcp-server` at the version this plugin pins; every later run uses the cache.
- A turn with no prompt captured (a resumed session) is still recorded from the answer and the calls.

## Remove it

`/plugin uninstall iris-eval-capture@iris-eval`. Recorded traces stay in your Iris home until retention sweeps them or you `iris-eval --purge`. The plugin's own data directory (above) can be deleted by hand.
