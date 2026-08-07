# Iris — Directory Listing Templates

Use these when submitting Iris to any MCP directory, awesome list, or marketplace.
Copy-paste the appropriate version and customize if needed.
**Refreshed 2026-07-07 against `.claims.json` (v0.4.4).** Before any submission, re-check the Key Stats against the current claims file.

---

## Short Description (1 line)

MCP-native eval and observability for AI agents. Log traces, evaluate output quality, track costs. Zero code changes.

## Medium Description (2-3 lines)

Iris is an MCP server that any agent discovers and uses automatically — no SDK, no code changes. Log every trace, evaluate output quality with 13 built-in rules, and track costs across all your agents. Open-source core. MIT licensed. 60 seconds to first trace.

## Long Description (paragraph)

Iris is the agent eval standard for MCP — an MCP-native eval and observability tool for AI agents. It registers as an MCP server that your agents discover automatically through the protocol — no SDK imports, no decorators, no code changes. Add one line to your MCP config and every agent starts logging hierarchical traces, evaluating output quality (10 PII patterns, 13 prompt-injection patterns, 17 hallucination markers, cost thresholds), verifying citations, and tracking per-trace costs in USD. LLM-as-judge included (BYOK, five templates). Self-hosted with a single SQLite file. Real-time dashboard. OpenTelemetry export. Works with Claude Desktop, Claude Code, Cursor, Windsurf, or any MCP-compatible agent. Open-source core, MIT licensed.

## Config Snippet (include in every listing)

```json
{
  "mcpServers": {
    "iris-eval": {
      "command": "npx",
      "args": ["-y", "@iris-eval/mcp-server"]
    }
  }
}
```

## Key Stats (for listings that show features)

- 9 MCP tools: log_trace, evaluate_output, get_traces, list_rules, deploy_rule, delete_rule, delete_trace, evaluate_with_llm_judge, verify_citations
- 13 built-in eval rules across 4 categories
- <1ms eval latency (heuristic layer; LLM-as-judge optional, BYOK)
- 0 lines of code to integrate
- SQLite storage — zero infrastructure
- OpenTelemetry OTLP export
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
- [Iris](https://github.com/iris-eval/mcp-server) - MCP-native eval and observability. Log traces, evaluate output quality, track costs. Zero code changes. [![Glama AAA](https://glama.ai/mcp/servers/iris-eval/mcp-server/badges/score.svg)](https://glama.ai/mcp/servers/iris-eval/mcp-server) [![MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/iris-eval/mcp-server/blob/main/LICENSE)
```
