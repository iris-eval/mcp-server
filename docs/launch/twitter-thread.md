# Twitter/X Launch Thread

---

**Tweet 1 (Announcement)**

Introducing Iris -- open-source observability for AI agents.

Log traces, evaluate output quality, and monitor cost. MCP-native, self-hosted, SQLite-powered.

github.com/iris-eval/mcp-server

---

**Tweet 2 (Problem)**

AI agents fail silently. The output looks plausible but is wrong. Costs spike. PII leaks into responses. Traditional APM shows HTTP 200 and calls it a day.

There is no standard way to monitor agent quality across runs.

---

**Tweet 3 (Solution)**

Iris is an MCP server -- not an SDK. Any MCP-compatible agent uses it automatically. No code changes needed.

3 tools:
- log_trace: record execution traces
- evaluate_output: score quality
- get_traces: query history

Works with Claude Desktop, Cursor, custom agents.

---

**Tweet 4 (Dashboard)**

Dark-mode web dashboard with real-time trace monitoring:

- Summary cards (total traces, avg score, pass rate, cost)
- Trace list with filters
- Span tree view for each execution
- Eval scores with per-rule breakdown

[SCREENSHOT: dashboard overview page]

---

**Tweet 5 (Eval engine)**

12 built-in eval rules across 4 categories:

Completeness: output length, coverage
Relevance: keyword overlap, hallucination markers
Safety: PII detection, injection patterns, blocklist
Cost: USD threshold, token efficiency

Plus custom rules via Zod schemas.

---

**Tweet 6 (CTA)**

MIT licensed. Self-hosted. TypeScript.

npm install -g @iris-eval/mcp-server
iris-mcp --dashboard

GitHub: github.com/iris-eval/mcp-server
npm: npmjs.com/package/@iris-eval/mcp-server

Star the repo if this is useful.
