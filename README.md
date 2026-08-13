# Iris — stop shipping agents on vibes

[![Glama Score](https://glama.ai/mcp/servers/iris-eval/mcp-server/badges/score.svg)](https://glama.ai/mcp/servers/iris-eval/mcp-server)
[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](cursor://anysphere.cursor-deeplink/mcp/install?name=iris-eval&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBpcmlzLWV2YWwvbWNwLXNlcnZlciJdLCJlbnYiOnsiSVJJU19MT0dfTEVWRUwiOiJpbmZvIn19)
[![npm version](https://img.shields.io/npm/v/@iris-eval/mcp-server)](https://npmjs.com/package/@iris-eval/mcp-server)
[![npm downloads](https://img.shields.io/npm/dt/@iris-eval/mcp-server)](https://npmjs.com/package/@iris-eval/mcp-server)
[![GitHub stars](https://img.shields.io/github/stars/iris-eval/mcp-server?style=social)](https://github.com/iris-eval/mcp-server)
[![CI](https://github.com/iris-eval/mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/iris-eval/mcp-server/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/iris-eval/mcp-server/badge)](https://securityscorecards.dev/viewer/?uri=github.com/iris-eval/mcp-server)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/12849/badge)](https://www.bestpractices.dev/projects/12849)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-ghcr.io-blue?logo=docker)](https://github.com/iris-eval/mcp-server/pkgs/container/mcp-server)
[![PulseMCP](https://img.shields.io/badge/PulseMCP-Listed-blue?style=flat-square)](https://www.pulsemcp.com/servers/iris-eval)
[![mcp.so](https://img.shields.io/badge/mcp.so-Listed-blue?style=flat-square)](https://mcp.so/server/iris/iris-eval)

**Iris scores every agent run for quality, safety, and cost — on your machine, with no SDK and no account.** Most agent projects check quality by running a few remembered prompts and eyeballing the output. Iris replaces that with numbers you can audit: your agent's runs land in a SQLite database on your disk, 13 built-in rules score them deterministically — PII, prompt injection, hallucination markers, cost thresholds — free, with no LLM calls, and an optional LLM judge with a hard per-eval cost cap handles the semantic questions. Every rule is inspectable and editable, because a judge you can't audit is just vibes with a number on it. MIT licensed, no telemetry; your traces never leave your machine.

**Requires Node.js 20 or later.** Check with `node --version`.

![Iris Dashboard](https://raw.githubusercontent.com/iris-eval/mcp-server/main/docs/assets/dashboard-overview.png)

## A failure on screen in 60 seconds

No agent wiring, no config — one command:

```bash
npx @iris-eval/mcp-server --demo
```

This seeds a demo database — a handful of small agents with a week of runs — and serves the dashboard against it at **http://localhost:6920** (your browser opens automatically on first run). The dashboard lands on **Failures**: what failed, worst and newest first. Worth clicking into — a PII leak caught by the safety rules, a flagged prompt-injection attempt, and a failed LLM-judge score with its rationale.

Demo data lives in its own database (`demo.db` in your Iris home directory — `~/.iris` on macOS/Linux, `%USERPROFILE%\.iris` on Windows) and never mixes with your real traces. Remove all of it with one command:

```bash
npx @iris-eval/mcp-server --demo-clear
```

## Hook up your own agent

Add Iris to your MCP config. Works with Claude Desktop, Claude Code, Cursor, Windsurf, Continue, VS Code, Cline, Zed, Codex CLI, Gemini CLI — and any other MCP-compatible agent. One block, dashboard included:

```json
{
  "mcpServers": {
    "iris-eval": {
      "command": "npx",
      "args": ["@iris-eval/mcp-server", "--dashboard"]
    }
  }
}
```

Your agent discovers Iris's nine tools on connect, and the dashboard serves at **http://localhost:6920**. Now paste this to your agent:

> Log that last task to Iris and evaluate the output.

The trace lands on the dashboard with its scores. Prefer the MCP server headless? Drop `--dashboard` from the args — you can open the same dashboard any time with `npx @iris-eval/mcp-server --dashboard`.

**One thing worth knowing up front:** MCP tools are called when the model decides to call them. Iris doesn't intercept your agent, so traces are logged when your agent asks it to log them — either because you told it to, or because your code calls the tools directly. Ask your agent to "log this to Iris and evaluate it" and it will. If you want capture that doesn't depend on the model choosing, `POST /api/v1/traces` does exactly that — your code sends the trace over plain HTTP, no model in the loop (see [docs/http-ingest.md](docs/http-ingest.md)). The CLI and SDKs on the [roadmap](docs/roadmap.md) will be thin clients over the same endpoint.

### Capture over HTTP (no model in the loop)

With the dashboard running, anything that can send an HTTP request can log a trace — and optionally run the deterministic evals in the same request:

```bash
curl -s -X POST "http://127.0.0.1:6920/api/v1/traces" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_name": "support-bot",
    "input": "What is the refund policy?",
    "output": "Refunds are available within 30 days of purchase.",
    "evaluate": true,
    "eval_type": "safety"
  }'
```

Returns `201` with the stored `trace_id` and the evaluation result. The endpoint accepts the same body as the `log_trace` tool and sits behind the same loopback-only middleware stack as the rest of the dashboard. Full contract, field reference, and error semantics: [docs/http-ingest.md](docs/http-ingest.md).

### Check the install

```bash
npx @iris-eval/mcp-server --self-test
```

An offline install diagnostic: storage round-trip, deterministic evals, dashboard + DNS-rebinding guard — all inside an isolated temp home, so your real database is never opened. Exit code 0 = healthy, 1 = a check failed.

<details>
<summary><strong>Setup by tool</strong></summary>

#### Claude Desktop

Edit your MCP config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add the JSON config above, then restart Claude Desktop.

#### Claude Code

```bash
claude mcp add --transport stdio iris-eval -- npx @iris-eval/mcp-server
```

Then restart the session (`/clear` or relaunch) for tools to load.

> **Windows note:** Do *not* use `cmd /c` wrapper — it causes path parsing issues. The `npx` command works directly.

#### Cursor / Windsurf

Add to your workspace `.cursor/mcp.json` or global MCP settings using the JSON config above.

#### VS Code (native MCP)

Add to `.vscode/mcp.json` in your workspace (note: VS Code uses `servers`, not `mcpServers`):

```json
{
  "servers": {
    "iris-eval": {
      "command": "npx",
      "args": ["@iris-eval/mcp-server"]
    }
  }
}
```

#### Cline

Open Cline's MCP Servers panel → Configure MCP Servers, and add the `mcpServers` JSON config above to `cline_mcp_settings.json`.

#### Zed

Add to Zed `settings.json`:

```json
{
  "context_servers": {
    "iris-eval": {
      "command": {
        "path": "npx",
        "args": ["@iris-eval/mcp-server"]
      }
    }
  }
}
```

#### OpenAI Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.iris-eval]
command = "npx"
args = ["@iris-eval/mcp-server"]
```

#### Gemini CLI

Add the `mcpServers` JSON config above to `~/.gemini/settings.json`.

#### Anything else that speaks MCP

Iris is a standard stdio MCP server — one `npx @iris-eval/mcp-server` command, no SDK, no code changes. If your client supports MCP, it supports Iris. Client config formats change; when in doubt, check your client's MCP docs and point it at that command.

</details>

### Other Install Methods

```bash
# Global install (recommended for persistent data and faster startup)
npm install -g @iris-eval/mcp-server
iris-mcp --dashboard

# Docker — two servers, two ports: 3000 = MCP HTTP transport,
# 6920 = dashboard (which also serves the POST /api/v1/traces ingest endpoint)
docker run -p 3000:3000 -p 6920:6920 -v iris-data:/data ghcr.io/iris-eval/mcp-server
```

> **Tip:** Global install (`npm install -g`) stores traces persistently at `~/.iris/iris.db`. With `npx`, traces persist in the same location, but startup is slower due to package resolution.

## What You Get

| | |
|---|---|
| **Trace Logging** | Hierarchical span trees with per-tool-call latency, token usage, and cost in USD. Stored in SQLite, queryable instantly. |
| **Output Evaluation** | 13 built-in rules across 4 categories: completeness, relevance, safety, cost. PII detection (19 patterns: SSN, credit card, phone, email, IBAN, DOB, MRN, IP, API key, passport, plus AWS/Slack/SendGrid/GitHub/Google/npm/DigitalOcean tokens, PEM private-key blocks and seed phrases), prompt injection (37 patterns, phrase + structural), stub-output detection, hallucination detection (25 context-grounded fabrication/contradiction signals — pass `input` to ground them against the agent's source material). Add custom rules with Zod schemas. |
| **LLM-as-Judge** | Optional semantic scoring via Anthropic or OpenAI — bring your own API key. Five templates. Hard per-eval cost cap (`IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL`, default $0.25), per-eval pricing disclosed in the result. |
| **Cost Visibility** | Aggregate cost across all agents over any time window. Set budget thresholds. Get flagged when agents overspend. |
| **Web Dashboard** | Real-time dark-mode UI that lands on the failures, worst and newest first — trace visualization, eval results, cost breakdowns, and a command palette (⌘K) that searches your own rules, traces, and evals. |
| **Local-first** | Everything lives in SQLite on your disk. No account, no sign-up, no telemetry. Outbound HTTP happens only where you opt in: your own LLM-judge key, citation fetching, or an OTel exporter you configure. |

Where this is going next: [the roadmap](docs/roadmap.md).

## MCP Tools

Iris registers nine tools that any MCP-compatible agent can invoke — full rule + trace lifecycle + LLM-as-judge + semantic citation verification:

- **`log_trace`** — Log an agent execution with spans, tool calls, token usage, and cost
- **`evaluate_output`** — Score output quality against completeness, relevance, safety, and cost rules (heuristic, deterministic, free)
- **`get_traces`** — Query stored traces with filtering, pagination, and time-range support
- **`list_rules`** — Enumerate deployed custom eval rules (read-only)
- **`deploy_rule`** — Register a new custom eval rule so it fires on every `evaluate_output` of that category
- **`delete_rule`** — Remove a deployed custom rule (destructive, idempotent)
- **`delete_trace`** — Remove a single stored trace by ID (destructive, tenant-scoped)
- **`evaluate_with_llm_judge`** — Semantic eval via LLM (Anthropic or OpenAI). Five templates: accuracy, helpfulness, safety, correctness, faithfulness. Cost-capped, per-eval pricing disclosed. **Bring your own API key** (`IRIS_ANTHROPIC_API_KEY` or `IRIS_OPENAI_API_KEY`) — Iris doesn't proxy or relay LLM calls.
- **`verify_citations`** — Extract citations from output (numbered, author-year, URLs, DOIs), fetch sources behind an SSRF-guarded + domain-allowlisted resolver, and use an LLM judge to check whether each source actually supports the cited claim. Opt-in outbound HTTP. Same BYOK requirement as `evaluate_with_llm_judge`.

When `IRIS_OTEL_ENDPOINT` is configured, `log_trace` calls also emit a best-effort OTLP/HTTP JSON export to any OpenTelemetry collector (Jaeger, Grafana Tempo, Datadog OTLP, Honeycomb, etc). See [docs/otel-integration.md](docs/otel-integration.md).

### How `passed` is decided

`evaluate_output` returns both a `score` and a `passed` flag — they answer different questions:

- **`score`** (0..1) is the weighted average across the rules that ran — a quality gradient.
- **`passed`** is the ship/no-ship verdict: `true` only when the score clears the pass threshold (default **0.7**) **and no critical rule failed**.

Genuine safety violations hard-fail. `no_pii`, `no_injection_patterns`, and `no_blocklist_words` are **critical rules**: if one fails, the eval reports `passed: false` no matter how well the other rules scored, and the response names the culprits in `critical_failures`. A leaked SSN can't be averaged away. Custom rules deployed with `severity: "high"` or `"critical"` hard-fail the same way; `low`/`medium` severities only affect the score. One boundary to know: a critical rule that **skipped** (missing context, or any other cause of a skip) has not judged the output and does not veto — `rule_results` shows every skip and its reason, so a gate that must fail closed on non-verdicts can.

One gotcha for CI gates: if you omit `eval_type`, the default `completeness` bundle runs — **safety rules don't**. The response echoes `eval_type` (plus a `note` when it was defaulted) so your gate can verify which bundle actually ran. Key on `passed` for the verdict and `eval_type: "safety"` for coverage.

Full tool schemas and configuration: [iris-eval.com](https://iris-eval.com)

## Hosted features

Iris runs entirely on your machine today, and everything it does is free and MIT licensed with no limits and no account.

Hosted storage, shared team history and alerting are **under consideration, not under construction**. There is no pricing, and nothing to buy. If shared history would be useful to you, [the waitlist](https://iris-eval.com#waitlist) is how we find out whether it's worth building — it commits you to nothing.

Two commitments hold regardless: **nothing that is free today will move behind a paywall**, and **no compliance certification will be claimed before it is held**.

## Examples

- [Claude Desktop setup](examples/claude-desktop/) — MCP config for stdio and HTTP modes
- [TypeScript — MCP SDK client](examples/typescript/basic-usage.ts) — connect and invoke tools
- [HTTP transport (TS + Python)](examples/http-transport/) — full client code for REST-style integration
- [LangChain instrumentation (Python, conceptual)](examples/langchain/observe-agent.py) — scaffold showing the shape; needs your agent code to be runnable
- [CrewAI instrumentation (Python, conceptual)](examples/crewai/observe-crew.py) — scaffold; same caveat

## Community

- [GitHub Issues](https://github.com/iris-eval/mcp-server/issues) — Bug reports and feature requests
- [GitHub Discussions](https://github.com/iris-eval/mcp-server/discussions) — Questions and ideas
- [Contributing Guide](CONTRIBUTING.md) — How to contribute
- [HTTP Ingest](docs/http-ingest.md) — Deterministic trace capture via `POST /api/v1/traces`
- [Roadmap](docs/roadmap.md) — What's coming next

<details>
<summary><strong>Configuration & Security</strong></summary>

### CLI Arguments

| Flag | Default | Description |
|------|---------|-------------|
| `--transport` | `stdio` | Transport type: `stdio` or `http` |
| `--port` | `3000` | HTTP transport port |
| `--db-path` | `~/.iris/iris.db` | SQLite database path |
| `--config` | `~/.iris/config.json` | Config file path |
| `--api-key` | — | API key for HTTP authentication |
| `--dashboard` | `false` | Enable web dashboard |
| `--dashboard-port` | `6920` | Dashboard port |
| `--dashboard-host` | `127.0.0.1` | Dashboard bind address. Loopback by default — the dashboard is unauthenticated unless `--api-key` is set, so binding beyond loopback exposes your full trace history |
| `--demo` | `false` | Seed a demo database (separate from your real traces) and serve the dashboard against it |
| `--demo-clear` | `false` | Delete the demo database and exit |
| `--self-test` | `false` | Run the offline install diagnostic in an isolated temp home, then exit (0 = healthy, 1 = a check failed) |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `IRIS_TRANSPORT` | Transport type (`stdio` or `http`) |
| `IRIS_PORT` | HTTP transport port |
| `IRIS_HOST` | HTTP transport host (default `127.0.0.1`) |
| `IRIS_HOME` | Directory for all per-user files: `config.json`, `iris.db`, `custom-rules.json`, `audit.log`, `preferences.json` (default `~/.iris`) |
| `IRIS_DB_PATH` | SQLite database path (overrides `IRIS_HOME` for the DB only) |
| `IRIS_LOG_LEVEL` | Log level: `debug`, `info`, `warn`, `error` |
| `IRIS_DASHBOARD` | Enable web dashboard (`true`/`false`; `false` also overrides `dashboard.enabled` in config.json) |
| `IRIS_DASHBOARD_PORT` | Dashboard port (default `6920`) |
| `IRIS_DASHBOARD_HOST` | Dashboard bind address (default `127.0.0.1`) |
| `IRIS_API_KEY` | API key for HTTP authentication |
| `IRIS_ALLOWED_ORIGINS` | Comma-separated allowed CORS origins |

CLI flags take precedence over environment variables when both are set.

### Security

When using HTTP transport, Iris includes:

- API key authentication with timing-safe comparison
- CORS restricted to localhost by default
- Rate limiting (600 req/min dashboard API, 20 req/min MCP)
- Helmet security headers
- Zod input validation on all routes
- ReDoS-safe regex for custom eval rules
- 1MB request body limits

```bash
# Production deployment
iris-mcp --transport http --port 3000 --api-key "$(openssl rand -hex 32)" --dashboard
```

</details>

<details>
<summary><strong>Troubleshooting</strong></summary>

### First move: run the self-test

```bash
npx @iris-eval/mcp-server --self-test
```

It checks storage, the deterministic evals, and the dashboard in an isolated temp home and prints a per-step verdict — the failure output names the broken step. Exit code 0 means the install is healthy.

### Iris won't start / `ERR_MODULE_NOT_FOUND`

You may have a cached older version. Clear the npx cache and retry:

```bash
npx --yes @iris-eval/mcp-server@latest
```

Or install globally to avoid cache issues entirely:

```bash
npm install -g @iris-eval/mcp-server@latest
```

### Tools not showing up in Claude Code

MCP tools only load at session start. After adding iris-eval, restart the session with `/clear` or relaunch the terminal.

### Version check

Iris logs its version on the first startup line:

```bash
npx @iris-eval/mcp-server --dashboard
# First log line: "Starting Iris MCP server vX.Y.Z"
```

For a global install, `npm ls -g @iris-eval/mcp-server` shows the installed version.

### Updating

```bash
# If using npx (clears cache and fetches latest)
npx --yes @iris-eval/mcp-server@latest

# If installed globally
npm update -g @iris-eval/mcp-server
```

### Node.js version

Iris requires Node.js 20 or later. Node 18 reached EOL in April 2025 and is not supported.

```bash
node --version  # Must be v20.x or v22.x+
```

### Windows: `cmd /c` not needed

Claude Code's `/doctor` may suggest wrapping npx with `cmd /c`. This is not needed and causes path parsing issues. Use `npx` directly:

```bash
# Correct
claude mcp add --transport stdio iris-eval -- npx @iris-eval/mcp-server

# Wrong (causes /c to be parsed as a path)
claude mcp add --transport stdio iris-eval -- cmd /c "npx @iris-eval/mcp-server"
```

</details>

---

If Iris is useful to you, [consider starring the repo](https://github.com/iris-eval/mcp-server) — it helps others find it.

[![Star on GitHub](https://img.shields.io/github/stars/iris-eval/mcp-server?style=social)](https://github.com/iris-eval/mcp-server)

MIT Licensed.
