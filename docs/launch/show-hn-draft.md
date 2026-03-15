# Show HN Draft

## Title

Show HN: Iris — first MCP-native eval and observability tool for AI agents

## Body

I kept running into the same problem building AI agents: once they're running, I have no idea what they're actually doing. Traditional monitoring shows me HTTP 200. It can't tell me the output was wrong, that the agent leaked a user's email address, or that a single tool call in the chain is burning through tokens.

So I built Iris. It's an open-source MCP server — not an SDK, not a proxy. Any MCP-compatible agent (Claude Desktop, Cursor, or anything built with the MCP SDK) discovers and uses it automatically. Add it to your MCP config and your agent gains observability without touching your code.

What it does:

- **3 MCP tools**: `log_trace` (full execution traces with spans, tool calls, token usage, cost in USD), `evaluate_output` (score output quality against configurable rules), `get_traces` (query traces with filters and pagination)
- **12 built-in eval rules** across 4 categories: completeness (output length, coverage), relevance (keyword overlap, hallucination markers), safety (PII detection for SSN/credit card/phone/email, prompt injection patterns, blocklist), and cost (USD threshold, token efficiency)
- **Hierarchical span tree**: trace exactly where in an agent's execution chain something went wrong — which tool call failed, which step was slow
- **Aggregate cost tracking**: the dashboard shows total agent spend across all your agents over any time window, not just per-trace cost. You can finally answer "what are my agents costing me?"
- **Web dashboard**: dark-mode React UI with summary cards, trace list, span tree view, eval results with per-rule breakdown
- **SQLite storage**: single file, no database server. Back it up, move it, inspect it with any SQLite tool
- **Custom eval rules** defined with Zod schemas

Security: API key auth, rate limiting (express-rate-limit), helmet headers, CORS, input validation, ReDoS-safe regex for user-supplied patterns, 1MB body limit.

Stack: TypeScript, Express 5, better-sqlite3, @modelcontextprotocol/sdk, Zod, pino.

Iris also exposes MCP resources — your agent can programmatically read `iris://dashboard/summary` to get aggregate metrics without opening the dashboard. Every trace logs full traceability, which also means you're building the audit trail that regulations like the EU AI Act will require by August 2026.

```
npm install -g @iris-eval/mcp-server
iris-mcp --transport http --dashboard
```

Self-hosted, MIT licensed.

GitHub: https://github.com/iris-eval/mcp-server
npm: https://www.npmjs.com/package/@iris-eval/mcp-server

I'd appreciate feedback on two things specifically:
1. The eval rule system — are these the right 12 rules to ship with? What's missing?
2. The MCP tool API — three tools feels minimal but sufficient. Should trace logging and evaluation be combined or kept separate?

Check the roadmap for what's coming next: https://github.com/iris-eval/mcp-server/blob/main/docs/roadmap.md
