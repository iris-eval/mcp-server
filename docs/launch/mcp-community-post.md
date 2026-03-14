# MCP Discord / Community Post

---

## Iris: MCP-Native Observability and Evaluation Server

We just released Iris, an open-source MCP server that provides trace logging, output evaluation, and a web dashboard for AI agents. We wanted to share it here because Iris is built on MCP from the ground up -- it is not just a client that connects to MCP servers, it **is** an MCP server that agents discover and invoke through the protocol.

### How It Works

Iris registers itself as an MCP server and exposes tools and resources that any MCP-compatible client can use. When you add Iris to your agent's MCP configuration, the agent gains access to observability capabilities without any SDK integration or code changes.

### Server Manifest

Here is the `server.json`:

```json
{
  "name": "iris-eval",
  "version": "0.1.0",
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

- **`log_trace`** -- Records a full agent execution: input, output, tool call chain, spans with timing, token usage, and cost in USD. Stored in SQLite and queryable through `get_traces` or the dashboard.
- **`evaluate_output`** -- Runs output text through an evaluation engine with 12 built-in rules (completeness, relevance, safety, cost). Returns a weighted score, pass/fail, and per-rule results with suggestions. Supports custom rules defined with Zod schemas.
- **`get_traces`** -- Queries stored traces with filters (agent name, time range, score range) and pagination.

### Resources

- **`iris://dashboard/summary`** -- Returns aggregate metrics: total traces, average scores, pass rates, cost totals, and recent trends. MCP clients can read this resource to display observability data without opening the dashboard.
- **`iris://traces/{trace_id}`** -- Returns full trace detail including all spans and linked evaluation results.

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

Internally, tools are registered using the `McpServer` class from `@modelcontextprotocol/sdk`. Each tool uses `registerTool` with Zod schemas for input validation. The server supports both `stdio` and `http` transports -- `stdio` for local MCP clients like Claude Desktop, `http` for networked deployments with API key authentication, rate limiting, and helmet security headers.

The eval engine uses a `registerRule` API, so you can extend it programmatically if you import Iris as a library rather than running it as a standalone server.

### What We Would Like Feedback On

- Is the tool API surface right? Three tools feels minimal but sufficient. Should trace logging and evaluation be separate tools or combined?
- Resource URIs: we used `iris://` scheme. Is there an emerging convention for MCP resource URIs?
- Are there MCP features we should be using that we are not? (Prompts, sampling, etc.)

GitHub: https://github.com/iris-eval/mcp-server
npm: https://www.npmjs.com/package/@iris-eval/mcp-server
License: MIT
