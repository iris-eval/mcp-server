# Iris — Directory Listing Templates

> **Rendered from `.claims.json` by `npm run llms:render`; `llms:check` fails if this file and the template disagree.** Every number below is a slot, so it cannot go stale between releases. Edit `docs/launch/directory-listing-template.template.md`, never this file. The three description blocks are the canonical listing copy — paste them, don't rewrite them.Never write a number that isn't in it, and never write "first", "best", "leading" or "standard". Under MCP a tool call is always the model's decision, so no listing may say Iris captures or scores "automatically".

Use these when submitting Iris to any MCP directory, awesome list, or marketplace.

---

## Short Description (1 line — Block A, 156 chars)

Stop shipping agents on vibes. An MCP server that scores every agent run for quality, safety, and cost — 20 deterministic rules, local SQLite, MIT licensed.

## Medium Description (short paragraph — Block B)

Stop shipping agents on vibes. Iris is an open-source MCP server that scores every agent run for quality, safety, and cost. 12 tools any MCP-compatible agent discovers automatically — no SDK, no code changes. 20 built-in rules (19 PII patterns, 37 prompt-injection patterns, 25 hallucination signals, cost thresholds, and 6 that read the agent's tool calls) score deterministically and free; a detected PII leak, injection, or blocklist hit fails the eval outright. Optional LLM judge and citation verification for the semantic questions. Self-hosted on SQLite, MIT-licensed core.

## Long Description (full paragraph — Block C)

Stop shipping agents on vibes. Iris is an open-source MCP server that scores every agent run for quality, safety, and cost. Any MCP-compatible agent discovers its 12 tools automatically — no SDK, no code changes. 20 built-in rules across completeness, relevance, safety, and cost score deterministically and free: 19 PII patterns, 37 prompt-injection patterns, 25 context-grounded hallucination signals, cost thresholds, and 6 trajectory rules that read the agent's tool calls. A detected PII leak, injection, or blocklist hit fails the eval outright, whatever the weighted score says. An optional LLM judge (5 templates, bring your own key, hard per-eval cost cap) and semantic citation verification handle what heuristics can't. Failure-first dashboard, OpenTelemetry export, self-hosted on SQLite — your traces stay on your machine. MIT-licensed core.

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

- 12 MCP tools: compare_runs, compare_traces, delete_rule, delete_trace, deploy_rule, evaluate_output, evaluate_runs, evaluate_with_llm_judge, get_traces, list_rules, log_trace, verify_citations
- 20 built-in eval rules across 4 categories (completeness, relevance, safety, cost)
- 19 PII patterns · 37 prompt-injection patterns · 25 context-grounded hallucination signals
- A detected PII leak, injection, or blocklist hit fails the eval regardless of the weighted score
- <1ms eval latency (heuristic layer; LLM-as-judge optional, 5 templates, BYOK, cost-capped)
- 0 lines of code to integrate
- SQLite storage — zero infrastructure; `--demo` puts a failure on screen in 60 seconds
- OpenTelemetry OTLP/HTTP export
- MIT licensed

## Links

- GitHub: https://github.com/iris-eval/mcp-server
- Website: https://iris-eval.com
- npm: https://www.npmjs.com/package/@iris-eval/mcp-server
- Install: `npx @iris-eval/mcp-server`

## Categories / Tags

mcp-server, mcp, model-context-protocol, eval, agent-eval, agent-evaluation, ai-agent, llm, llm-as-a-judge, cost-tracking, pii-detection, prompt-injection, quality-gate, tracing, observability

## Awesome List PR Template

```markdown
- [Iris](https://github.com/iris-eval/mcp-server) - Stop shipping agents on vibes. An MCP server that scores every agent run for quality, safety, and cost — 20 deterministic rules, local SQLite, MIT licensed. [![Glama AAA](https://glama.ai/mcp/servers/iris-eval/mcp-server/badges/score.svg)](https://glama.ai/mcp/servers/iris-eval/mcp-server) [![MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/iris-eval/mcp-server/blob/main/LICENSE)
```
