# Twitter/X Launch Thread

> **Note:** X posts have a 280-character limit (free tier) or 25,000 (Premium). Drafts below were trimmed to fit before publishing. Keep future drafts within limits.

---

**Tweet 1 (Announcement)**

I built the first MCP-native eval & observability tool for AI agents.

Iris is an open-source MCP server. Add it to your agent's config and it can log traces, evaluate output quality, and track what your agents are actually costing you.

No SDK. No code changes.

github.com/iris-eval/mcp-server

---

**Tweet 2 (Problem)**

AI agents fail silently. The output looks plausible but is wrong. Costs spike with no visibility. PII leaks into responses. Traditional APM sees HTTP 200 and calls it a day.

Your agents are black boxes in production. There hasn't been a standard way to monitor agent quality across runs — until now.

---

**Tweet 3 (Solution)**

Iris is an MCP server, not an SDK. Any MCP-compatible agent discovers and uses it automatically.

3 tools:
- log_trace: full execution traces with spans, tool calls, token usage, cost
- evaluate_output: score quality against 13 built-in rules
- get_traces: query history with filters

Works with Claude Desktop, Cursor, any MCP agent.

---

**Tweet 4 (Dashboard + Cost)**

The dashboard shows you what's actually happening inside your agents:

- Aggregate cost across all your agents over any time window
- Hierarchical span tree — see exactly where in the chain things go wrong
- Eval scores with per-rule breakdown
- Per-tool-call latency — find your bottleneck

[SCREENSHOT: dashboard overview page]

---

**Tweet 5 (Eval engine)**

12 built-in eval rules across 4 categories:

Completeness: output length, coverage, sentence count
Relevance: keyword overlap, hallucination markers, topic consistency
Safety: PII detection (SSN, credit card, phone, email), injection patterns, blocklist
Cost: USD threshold, token efficiency

Plus custom rules via Zod schemas.

---

**Tweet 6 (CTA)**

Open-source core. Self-hosted. MIT licensed. TypeScript.

```
npm install -g @iris-eval/mcp-server
iris-mcp --dashboard
```

GitHub: github.com/iris-eval/mcp-server
npm: npmjs.com/package/@iris-eval/mcp-server

Star the repo if this is useful. Check the roadmap for what's coming next.
