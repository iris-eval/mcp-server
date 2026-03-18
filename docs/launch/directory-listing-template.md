# Iris — Directory Listing Templates

Use these when submitting Iris to any MCP directory, awesome list, or marketplace.
Copy-paste the appropriate version and customize if needed.

---

## Short Description (1 line)

MCP-native eval and observability for AI agents. Log traces, evaluate output quality, track costs. Zero code changes.

## Medium Description (2-3 lines)

Iris is an MCP server that any agent discovers and uses automatically — no SDK, no code changes. Log every trace, evaluate output quality with 12 built-in rules, and track costs across all your agents. Open-source core. MIT licensed. 60 seconds to first trace.

## Long Description (paragraph)

Iris is the first MCP-native eval and observability tool for AI agents. It registers as an MCP server that your agents discover automatically through the protocol — no SDK imports, no decorators, no code changes. Add one line to your MCP config and every agent starts logging hierarchical traces, evaluating output quality (PII detection, prompt injection, hallucination markers, cost thresholds), and tracking per-trace costs in USD. Self-hosted with a single SQLite file. Real-time dark-mode dashboard. Works with Claude Desktop, Cursor, Windsurf, or any MCP-compatible agent. Open-source core, MIT licensed.

## Config Snippet (include in every listing)

```json
{
  "mcpServers": {
    "iris": {
      "command": "npx",
      "args": ["-y", "@iris-eval/mcp-server"]
    }
  }
}
```

## Key Stats (for listings that show features)

- 3 MCP tools: log_trace, evaluate_output, get_traces
- 12 built-in eval rules across 4 categories
- <1ms eval latency (heuristic, not LLM-as-Judge)
- 0 lines of code to integrate
- SQLite storage — zero infrastructure
- MIT licensed

## Links

- GitHub: https://github.com/iris-eval/mcp-server
- Website: https://iris-eval.com
- npm: https://www.npmjs.com/package/@iris-eval/mcp-server
- Install: `npx @iris-eval/mcp-server`

## Categories / Tags

mcp-server, mcp, model-context-protocol, eval, observability, ai-agent, tracing, monitoring, llm, cost-tracking, pii-detection, agent-evaluation

## Awesome List PR Template

```markdown
- [Iris](https://github.com/iris-eval/mcp-server) - MCP-native eval and observability. Log traces, evaluate output quality, track costs. Zero code changes. [![MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/iris-eval/mcp-server/blob/main/LICENSE)
```
