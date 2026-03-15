# MCP Discord / Community Post

---

## Iris: First MCP-Native Eval & Observability Server

I built Iris as the first MCP-native eval and observability tool for AI agents. Sharing it here because Iris is built on MCP from the ground up — it is not a client that connects to MCP servers, it **is** an MCP server that agents discover and invoke through the protocol.

### How It Works

Iris registers as an MCP server and exposes tools and resources that any MCP-compatible client can use. Add it to your agent's MCP configuration and the agent gains eval and observability capabilities without any SDK integration or code changes.

### Server Manifest

```json
{
  "name": "iris-eval",
  "version": "0.1.2",
  "tools": [
    { "name": "log_trace", "description": "Log an agent execution trace with spans, tool calls, and metrics" },
    { "name": "evaluate_output", "description": "Evaluate agent output quality using configurable rules" },
    { "name": "get_traces", "description": "Query stored traces with filters, pagination, and summary stats" }
  ],
  "resources": [
    { "uri": "iris://dashboard/summary", "description": "Dashboard summary with key metrics and trends" },
    { "uri_template": "iris://traces/{trace_id}", "description": "Full trace detail with spans and evaluation results" }
  ]
}
```

### Tools

- **`log_trace`** — Records a full agent execution: input, output, tool call chain with per-call latency, hierarchical spans with OpenTelemetry-compatible span kinds, token usage, and cost in USD. Stored in SQLite, queryable through `get_traces` or the dashboard.
- **`evaluate_output`** — Runs output through 12 built-in eval rules (completeness, relevance, safety, cost). Returns a weighted score, pass/fail, and per-rule results with actionable suggestions. Supports custom rules defined with Zod schemas.
- **`get_traces`** — Queries stored traces with filters (agent name, framework, time range, score range) and pagination.

### Resources

- **`iris://dashboard/summary`** — Returns aggregate metrics: total traces, average scores, pass rates, total cost across all agents, and recent trends. Your agent can read this resource programmatically to surface observability data without opening the dashboard.
- **`iris://traces/{trace_id}`** — Returns full trace detail including all spans and linked evaluation results.

### Claude Desktop Integration

Add this to your Claude Desktop MCP config and it works immediately:

```json
{
  "mcpServers": {
    "iris": {
      "command": "npx",
      "args": ["@iris-eval/mcp-server"]
    }
  }
}
```

### Technical Details

Tools are registered using the `McpServer` class from `@modelcontextprotocol/sdk` with Zod schemas for input validation. The server supports both `stdio` and `http` transports — `stdio` for local MCP clients like Claude Desktop, `http` for networked deployments with API key authentication, rate limiting, and helmet security headers.

The eval engine uses a `registerRule` API, so you can extend it programmatically if you import Iris as a library.

### What I'd Like Feedback On

- Is the tool API surface right? Three tools feels minimal but sufficient. Should trace logging and evaluation be separate tools or combined?
- Resource URIs: I used the `iris://` scheme. Is there an emerging convention for MCP resource URIs?
- The `iris://dashboard/summary` resource means agents can read their own observability metrics. Any interesting use cases you'd build on top of that?

GitHub: https://github.com/iris-eval/mcp-server
npm: https://www.npmjs.com/package/@iris-eval/mcp-server
Roadmap: https://github.com/iris-eval/mcp-server/blob/main/docs/roadmap.md
License: MIT
