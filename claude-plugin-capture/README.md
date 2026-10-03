# iris-eval-capture — record every Claude Code turn into Iris

**Opt-in, and its own plugin.** Installing `iris-eval` never changes your turn loop; installing this one does, and that is the whole point: capture that does not depend on the model deciding to call a tool.

```
/plugin marketplace add iris-eval/mcp-server
/plugin install iris-eval-capture@iris-eval
```

## What it records

A turn is one prompt and what followed it, kept under the prompt's id (`prompt_id`, which Claude Code sends on every hook from version 2.1.196). Five hook events:

| Event | What it adds |
|---|---|
| `UserPromptSubmit` | the prompt, and sends whatever an earlier turn of the session did not (below) |
| `PostToolUse` | each tool call that succeeded: name, input, result, and how long it took when Claude Code reports it |
| `PostToolUseFailure` | each tool call that failed: name, input, and the error the agent received (a command's `Exit code 1` and its output, a missing file, an MCP tool's error); a call that reached Claude Code as an abort is recorded as `interrupted: …` |
| `Stop` | the final answer, and hands the turn to Iris |
| `StopFailure` | a turn that ended in an API error (a rate limit, an overloaded model, a failed credential) |

A turn is handed to `iris-eval ingest --evaluate --redact critical_spans --source hook` as `{ input, output, tool_calls, run: <session id> }`, detached, so your turn never waits on the evaluation. The trace lands in your Iris home (`~/.iris/iris.db`) with its verdict; open the dashboard to read it. Each trace's `metadata.turn` names the prompt it belongs to, which part of the turn it is, and how that part ended.

### Turns that do not end cleanly

Nothing a turn records is deleted before it is sent.

| What happened | What Iris gets |
|---|---|
| You interrupted the turn (Claude Code fires no `Stop` on an interrupt) | When your next prompt arrives, the turn's calls, as a part that ended `unfinished`: stored, not judged, since there is no answer to judge |
| A background sub-agent kept working after the turn ended | Its calls, as a later `unfinished` part of the turn it belongs to, sent when the next prompt arrives (Claude Code delivers a sub-agent's report as a prompt). Calls a sub-agent made are named in `metadata.subagent_calls`, with its id and type |
| A `Stop` hook (such as `/goal`) kept the turn going | A second part, `continued`, with the prompt, the answer the turn ended on this time, and the calls since the first end; judged like the first |
| The turn ended in an API error | A part that ended `failed`, with its calls and the error under `metadata.stop_failure`, and no answer: stored, not judged, so a rate limit is not scored as an answer |
| A session you closed and never came back to | Sent, the same way, when a later session starts a turn a day or more after it was last touched |

### When `tool_calls` is empty

An empty list says no call was made, and Iris's rules read it so. It is sent only when the record is known whole: the turn's prompt was seen, the turn ended with `Stop` the first time, and Claude Code reported nothing still running in the background. Otherwise a turn with no recorded call sends no list, which says nothing either way.

## What it deliberately does not do

- **It never lets the model's account replace its own.** If the model called `log_trace` itself during the turn (the `iris-eval` plugin's instructions ask it to, for answers you will act on), both traces are kept: the model's, and this hook's record of what the host saw, which names the model's trace once in `metadata.model_logged.trace_ids`. A `log_trace` call that failed is counted apart (`failed`). Iris's own tool calls are left out of the recorded trajectory, under any of the names Claude Code gives them (`iris-eval`, `iris`, or the plugin-bundled server).
- **It never prints.** A Stop hook's stdout becomes context the model sees. Everything this plugin has to say goes to `capture.log` in its data directory.
- **It never blocks.** The hook writes each part to a file under the plugin's data directory (`pending/`) and detaches a small runner that hands it to `iris-eval ingest` and exits; the hook itself returns in milliseconds. A part the runner could not ingest stays in `pending/`, with the reason in `capture.log`, and is retried by a later `Stop` (a few at a time, once it is ten minutes old) until it is seven days old, then removed. (`IRIS_CAPTURE_WAIT=1` makes the hook wait for the runner instead, for tests and for hosts that reap detached children.)
- **It never sends anything anywhere.** `ingest` is local; nothing leaves the machine unless you have configured Iris to export.

## Where it keeps what it holds

What this plugin holds is the text of your turns, so it is kept like a secret:

- In the directory Claude Code gives the plugin (`CLAUDE_PLUGIN_DATA`), or, when a host sets none, in `capture/` inside your Iris home (`IRIS_HOME`, or `~/.iris`). Never in a shared temporary directory another user could create first. (Versions before 0.20.0 kept turns that failed to ingest in your system's temporary directory, under `iris-eval-capture/`; this version neither reads nor removes it, so delete it by hand if it is there.)
- Directories readable by you alone (`0700`), files by you alone (`0600`), on systems with POSIX permissions.
- A turn's calls are appended one line each as they finish, so calls the host runs in parallel are all kept; each starts on a fresh line, so a write cut short loses only itself.
- A tool's output or error over 256 KB is kept as its first and last 128 KB, marked `truncated`, so the hook finishes inside its timeout whatever the tool printed.
- A turn's files are removed once the turn is sent and the next prompt arrives; a session's, once it is closed as above. `capture.log` is rotated at 1 MB, one previous file kept.
- Both ingest attempts run the version this plugin pins, from `npx`'s cache first and then by installing it.

## Named limits

- Only the **final** assistant message of a turn is recorded (`last_assistant_message`); intermediate assistant text is not.
- A call Claude Code rejects before it runs (an unknown tool, input that fails validation, a permission denial) fires no hook and is not recorded; nor does a running tool you cancel.
- A claim one turn makes about another turn's work is judged against its own turn's calls only.
- Tool responses and answers are stored locally and may contain secrets from your own tools. Redaction of critical spans is **on by construction** for this path (`--redact critical_spans`): the text the **evaluation** stores has every span a critical detector flagged replaced by `[REDACTED:<pattern>]`. The **trace** itself keeps the record, as it does on every door — a finding has to point at something — so a turn that must not be retained is removed with `delete_trace` or swept by retention.
- The first run pays `npx`'s cold start to fetch `@iris-eval/mcp-server` at the version this plugin pins; every later run uses the cache.
- With a Claude Code older than 2.1.196, which sends no prompt id, calls are kept under the turn the session's last prompt began; a background sub-agent's calls after that then land in the next turn.

## Remove it

`/plugin uninstall iris-eval-capture@iris-eval`. Recorded traces stay in your Iris home until retention sweeps them or you `iris-eval --purge`. The plugin's own data directory (above) can be deleted by hand.
