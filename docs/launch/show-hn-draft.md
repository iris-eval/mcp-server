# Show HN Draft

## Title

Show HN: Iris -- Open-source agent observability via MCP protocol

## Body

Iris is an open-source MCP server that provides trace logging, output evaluation, and a web dashboard for AI agents. It works at the protocol level -- any MCP-compatible agent (Claude Desktop, Cursor, custom agents) can use it without importing an SDK or adding client code.

What's included:

- 3 MCP tools: `log_trace` (record full execution traces with spans, tool calls, token usage, cost), `evaluate_output` (score output quality against configurable rules), `get_traces` (query traces with filters and pagination)
- 12 built-in eval rules across 4 categories: completeness, relevance, safety (PII detection, injection pattern matching, blocklist), and cost (threshold checks, token efficiency)
- React dashboard with dark mode: summary cards, trace list, span tree view, eval results
- SQLite storage (single file, no database server)
- Custom eval rules with Zod-validated schemas

Tech stack: TypeScript, Express 5, better-sqlite3, @modelcontextprotocol/sdk, Zod, pino. Security: API key auth, rate limiting (express-rate-limit), helmet, CORS, input validation, ReDoS-safe regex, 1MB body limit.

Self-hosted, MIT licensed. No cloud dependency.

```
npm install -g @iris-eval/mcp-server
iris-mcp --transport http --dashboard
```

GitHub: https://github.com/iris-eval/mcp-server
npm: https://www.npmjs.com/package/@iris-eval/mcp-server

Would appreciate feedback on the eval rule system and the MCP tool API design. This is our first release.
