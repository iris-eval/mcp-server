# Iris — MCP-Native Agent Eval & Observability

[![npm version](https://img.shields.io/npm/v/@iris-eval/mcp-server)](https://npmjs.com/package/@iris-eval/mcp-server)
[![CI](https://github.com/iris-eval/mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/iris-eval/mcp-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

Iris is an open-source [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that provides trace logging, quality evaluation, and drift detection for AI agents. Any MCP-compatible agent framework can discover and invoke Iris tools.

![Iris Dashboard](https://raw.githubusercontent.com/iris-eval/mcp-server/main/docs/assets/dashboard-overview.png)

## Quickstart

```bash
npm install -g @iris-eval/mcp-server
iris-mcp
```

Or run directly:

```bash
npx @iris-eval/mcp-server
```

### Docker

```bash
docker run -p 3000:3000 -v iris-data:/data ghcr.io/iris-eval/mcp-server
```

## Configuration

Iris looks for config in this order (later overrides earlier):

1. Built-in defaults
2. `~/.iris/config.json`
3. Environment variables (`IRIS_*`)
4. CLI arguments

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

## Security

When using the HTTP transport, Iris includes production-grade security:

- **Authentication** — Set `IRIS_API_KEY` or `--api-key` to require `Authorization: Bearer <key>` on all endpoints (except `/health`). Recommended for any network-exposed deployment.
- **CORS** — Restricted to `http://localhost:*` by default. Configure with `IRIS_ALLOWED_ORIGINS`.
- **Rate limiting** — 100 requests/minute for dashboard API, 20 requests/minute for MCP endpoints. Configurable via `~/.iris/config.json`.
- **Security headers** — Helmet middleware applies CSP, X-Frame-Options, X-Content-Type-Options, and other standard headers.
- **Input validation** — All query parameters validated with Zod schemas. Malformed requests return 400.
- **Request size limits** — Body payloads limited to 1MB by default.
- **Safe regex** — User-supplied regex patterns in custom eval rules are validated against ReDoS attacks.
- **Structured logging** — JSON logs to stderr via pino. Never writes to stdout (reserved for stdio transport).

```bash
# Production deployment example
iris-mcp --transport http --port 3000 --api-key "$(openssl rand -hex 32)" --dashboard
```

## MCP Tools

### `log_trace`

Log an agent execution trace with spans, tool calls, and metrics.

**Input:**
- `agent_name` (required) — Name of the agent
- `input` — Agent input text
- `output` — Agent output text
- `tool_calls` — Array of tool call records
- `latency_ms` — Execution time in milliseconds
- `token_usage` — `{ prompt_tokens, completion_tokens, total_tokens }`
- `cost_usd` — Total cost in USD
- `metadata` — Arbitrary key-value metadata
- `spans` — Array of span objects for detailed tracing

### `evaluate_output`

Evaluate agent output quality using configurable rules.

**Input:**
- `output` (required) — The text to evaluate
- `eval_type` — Type: `completeness`, `relevance`, `safety`, `cost`, `custom`
- `expected` — Expected output for comparison
- `trace_id` — Link evaluation to a trace
- `custom_rules` — Array of custom rule definitions

### `get_traces`

Query stored traces with filters and pagination.

**Input:**
- `agent_name` — Filter by agent name
- `framework` — Filter by framework
- `since` — ISO timestamp lower bound
- `until` — ISO timestamp upper bound
- `min_score` / `max_score` — Score range filter
- `limit` — Results per page (default 50)
- `offset` — Pagination offset

## MCP Resources

- `iris://dashboard/summary` — Dashboard summary statistics
- `iris://traces/{trace_id}` — Full trace detail with spans and evals

## Claude Desktop

Add Iris to your Claude Desktop MCP config:

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

Then ask Claude to "log a trace" or "evaluate this output" — Iris tools are automatically available.

See [examples/claude-desktop/](examples/claude-desktop/) for more configuration options.

## Web Dashboard

Start with `--dashboard` flag to enable the web UI at `http://localhost:6920`.

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

## License

MIT
