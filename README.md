# Iris — The Agent Eval Standard for MCP

[![Glama Score](https://glama.ai/mcp/servers/iris-eval/mcp-server/badges/score.svg)](https://glama.ai/mcp/servers/iris-eval/mcp-server)
[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](cursor://anysphere.cursor-deeplink/mcp/install?name=server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBpcmlzLWV2YWwvbWNwLXNlcnZlciJdLCJlbnYiOnsiSVJJU19MT0dfTEVWRUwiOiJpbmZvIn19)
[![npm version](https://img.shields.io/npm/v/@iris-eval/mcp-server)](https://npmjs.com/package/@iris-eval/mcp-server)
[![npm downloads](https://img.shields.io/npm/dt/@iris-eval/mcp-server)](https://npmjs.com/package/@iris-eval/mcp-server)
[![GitHub stars](https://img.shields.io/github/stars/iris-eval/mcp-server?style=social)](https://github.com/iris-eval/mcp-server)
[![CI](https://github.com/iris-eval/mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/iris-eval/mcp-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-ghcr.io-blue?logo=docker)](https://github.com/iris-eval/mcp-server/pkgs/container/mcp-server)
[![PulseMCP](https://img.shields.io/badge/PulseMCP-Listed-blue?style=flat-square)](https://www.pulsemcp.com/servers/iris-eval)
[![mcp.so](https://img.shields.io/badge/mcp.so-Listed-blue?style=flat-square)](https://mcp.so/server/iris/iris-eval)

**Know whether your AI agents are actually good enough to ship.** Iris is an open-source MCP server that scores output quality, catches safety failures, and enforces cost budgets across all your agents. Any MCP-compatible agent discovers and uses it automatically — no SDK, no code changes.

![Iris Dashboard](https://raw.githubusercontent.com/iris-eval/mcp-server/main/docs/assets/dashboard-overview.png)

## The Problem

Your agents are running in production. Infrastructure monitoring sees `200 OK` and moves on. It has no idea the agent just:

- Leaked a social security number in its response
- Hallucinated an answer with zero factual grounding
- Burned $0.47 on a single query — 4.7x your budget threshold
- Made 6 tool calls when 2 would have sufficed

Iris evaluates all of it.

## What You Get

| | |
|---|---|
| **Trace Logging** | Hierarchical span trees with per-tool-call latency, token usage, and cost in USD. Stored in SQLite, queryable instantly. |
| **Output Evaluation** | 12 built-in rules across 4 categories: completeness, relevance, safety, cost. PII detection, prompt injection patterns, hallucination markers. Add custom rules with Zod schemas. |
| **Cost Visibility** | Aggregate cost across all agents over any time window. Set budget thresholds. Get flagged when agents overspend. |
| **Web Dashboard** | Real-time dark-mode UI with trace visualization, eval results, and cost breakdowns. |

**Requires Node.js 20 or later.** Check with `node --version`.

## Quickstart

Add Iris to your MCP config. Works with Claude Desktop, Cursor, Windsurf, and any MCP-compatible agent.

```json
{
  "mcpServers": {
    "iris-eval": {
      "command": "npx",
      "args": ["@iris-eval/mcp-server"]
    }
  }
}
```

That's it. Your agent discovers Iris and starts logging traces automatically.

Want the dashboard?

```bash
npx @iris-eval/mcp-server --dashboard
# Open http://localhost:6920
```

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

</details>

### Other Install Methods

```bash
# Global install (recommended for persistent data and faster startup)
npm install -g @iris-eval/mcp-server
iris-mcp --dashboard

# Docker
docker run -p 3000:3000 -v iris-data:/data ghcr.io/iris-eval/mcp-server
```

> **Tip:** Global install (`npm install -g`) stores traces persistently at `~/.iris/iris.db`. With `npx`, traces persist in the same location, but startup is slower due to package resolution.

## MCP Tools

Iris registers three tools that any MCP-compatible agent can invoke:

- **`log_trace`** — Log an agent execution with spans, tool calls, token usage, and cost
- **`evaluate_output`** — Score output quality against completeness, relevance, safety, and cost rules
- **`get_traces`** — Query stored traces with filtering, pagination, and time-range support

Full tool schemas and configuration: [iris-eval.com](https://iris-eval.com)

## Cloud Tier (Coming Soon)

Self-hosted Iris runs on your machine with SQLite. As your team's eval needs grow, the cloud tier adds PostgreSQL, team dashboards, alerting on quality regressions, and managed infrastructure.

[Join the waitlist](https://iris-eval.com#waitlist) to get early access.

## Examples

- [Claude Desktop setup](examples/claude-desktop/) — MCP config for stdio and HTTP modes
- [TypeScript](examples/typescript/basic-usage.ts) — MCP SDK client usage
- [LangChain](examples/langchain/observe-agent.py) — Agent instrumentation
- [CrewAI](examples/crewai/observe-crew.py) — Crew observability

## Community

- [GitHub Issues](https://github.com/iris-eval/mcp-server/issues) — Bug reports and feature requests
- [GitHub Discussions](https://github.com/iris-eval/mcp-server/discussions) — Questions and ideas
- [Contributing Guide](CONTRIBUTING.md) — How to contribute
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

### Environment Variables

| Variable | Description |
|----------|-------------|
| `IRIS_TRANSPORT` | Transport type |
| `IRIS_PORT` | HTTP port |
| `IRIS_DB_PATH` | Database path |
| `IRIS_LOG_LEVEL` | Log level: debug, info, warn, error |
| `IRIS_DASHBOARD` | Enable dashboard (true/false) |
| `IRIS_API_KEY` | API key for HTTP authentication |
| `IRIS_ALLOWED_ORIGINS` | Comma-separated allowed CORS origins |

### Security

When using HTTP transport, Iris includes:

- API key authentication with timing-safe comparison
- CORS restricted to localhost by default
- Rate limiting (100 req/min API, 20 req/min MCP)
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

Verify which version is running:

```bash
npx @iris-eval/mcp-server --help
# Shows "Iris MCP-Native Agent Eval & Observability Server vX.Y.Z"
```

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
