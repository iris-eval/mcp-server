---
title: "Why Your AI Agents Need Observability"
published: false
description: "You shipped an AI agent. It works... sometimes. A user reports a wrong answer. Another says it took 40 seconds. A third notices it leaked an email address ..."
tags: mcp, aiagents, observability, opensource
canonical_url: https://iris-eval.com/blog/why-your-ai-agents-need-observability
---

You shipped an AI agent. It works... sometimes. A user reports a wrong answer. Another says it took 40 seconds. A third notices it leaked an email address in its response. But you have no logs, no metrics, no way to reproduce what happened. You check your APM dashboard and see HTTP 200s across the board. Everything looks fine. Everything is not fine.

This is the observability gap for AI agents, and it is growing wider as agents get deployed into more critical workflows.

## Traditional APM Does Not Understand Agents

Application performance monitoring tools like Datadog, New Relic, and Grafana are built for request-response services. They track HTTP status codes, latency percentiles, error rates, and throughput. These metrics matter, but they miss what makes agents different.

An agent execution is not a single request. It is a multi-step workflow: the LLM reasons about the task, selects tools, calls them in sequence or parallel, synthesizes results, and produces a final output. A single agent run might involve 5 tool calls, 3 LLM inference steps, and 12,000 tokens. Traditional APM sees one successful HTTP request. It cannot tell you:

- Which tool call in the chain failed or returned unexpected data
- Whether the LLM's reasoning steps were coherent
- How much the execution cost in tokens and dollars
- Whether the output quality degraded compared to last week
- If the agent leaked PII in its response

These are agent-specific concerns. They require agent-specific observability.

## What Agent Observability Actually Means

Agent observability rests on three pillars:

**1. Trace every step.** Record the full execution path: input, output, each span (LLM call, tool call, retrieval step), latency per span, token usage, cost. Store it in a queryable format so you can reconstruct any execution after the fact. This is the foundation. Without structured traces, debugging is guesswork.

**2. Evaluate every output.** Logging is necessary but not sufficient. You need automated quality checks that run on every output: Is the response complete? Is it relevant to the input? Does it contain PII? Did it exceed your cost budget? Evaluation turns raw traces into actionable signals. A score of 0.4 on the completeness check tells you something specific. An HTTP 200 does not.

**3. Detect drift.** Agent quality degrades over time. Model updates change behavior. Prompt edits have unintended side effects. Data sources go stale. You need to track scores and metrics over time and detect when they shift. A 15% drop in relevance scores over the last 48 hours is a signal worth acting on.

## Introducing Iris

Iris is an open-source observability server built specifically for AI agents. It implements the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP), which means any MCP-compatible agent can discover and use Iris without SDK integration, client libraries, or code changes. You add Iris to your agent's MCP server list, and it gains three capabilities: trace logging, output evaluation, and trace querying.

Key design decisions:

- **MCP-native.** Iris is not a library you import. It is an MCP server that exposes tools. Any agent that speaks MCP (Claude Desktop, Cursor, custom agents built with the MCP SDK) can use it out of the box.
- **Self-hosted.** Your data stays on your infrastructure. No cloud dependency, no third-party data processing.
- **SQLite-powered.** No database server to manage. Traces are stored in a local SQLite file at `~/.iris/iris.db`. Production deployments can point to any path.

## Three Capabilities

### 1. Log a Trace

The `log_trace` tool records a full agent execution:

```json
{
  "agent_name": "support-bot",
  "input": "How do I reset my password?",
  "output": "Navigate to Settings > Security > Reset Password...",
  "tool_calls": [
    { "tool_name": "search_docs", "input": "password reset", "output": "..." }
  ],
  "latency_ms": 1200,
  "token_usage": { "prompt_tokens": 450, "completion_tokens": 120, "total_tokens": 570 },
  "cost_usd": 0.0034
}
```

### 2. Evaluate Output Quality

The `evaluate_output` tool runs your output through configurable rules and returns a score:

```json
{
  "output": "Navigate to Settings > Security > Reset Password...",
  "eval_type": "safety",
  "trace_id": "trc_abc123"
}
```

Response:

```json
{
  "score": 1.0,
  "passed": true,
  "rule_results": [
    { "ruleName": "no_pii", "passed": true, "score": 1.0 },
    { "ruleName": "no_blocklist_words", "passed": true, "score": 1.0 },
    { "ruleName": "no_injection_patterns", "passed": true, "score": 1.0 }
  ]
}
```

### 3. Query Traces

The `get_traces` tool retrieves stored traces with filters:

```json
{
  "agent_name": "support-bot",
  "since": "2026-03-12T00:00:00Z",
  "min_score": 0.5,
  "limit": 20
}
```

## The Dashboard

Start Iris with `--dashboard` to enable a dark-mode web UI at `http://localhost:6920`. The dashboard displays:

- **Summary cards** showing total traces, average score, pass rate, and total cost
- **Trace list** with sortable columns and filters by agent, time range, and score
- **Span tree** view for each trace, showing the full execution path with timing
- **Evaluation results** with per-rule scores and suggestions for improvement

All data updates in real-time as new traces arrive.

## Getting Started

Three lines to get running:

```bash
npm install -g @iris-eval/mcp-server
iris-mcp --transport http --dashboard
# Open http://localhost:6920
```

Or add Iris to your Claude Desktop MCP config:

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

That is it. Your agent can now call `log_trace`, `evaluate_output`, and `get_traces` as MCP tools.

## What's Next

Iris v0.1.0 covers the core: trace logging, evaluation, querying, and the dashboard. Here is what we are working on next:

- **Cloud tier** for teams: PostgreSQL storage, multi-tenancy, shared dashboards, API key management
- **Alerting**: webhooks and email notifications when scores drop or error rates spike
- **Framework integrations**: step-by-step guides for LangChain, CrewAI, AutoGen, and other popular agent frameworks

Iris is MIT-licensed and open source. The code is at [github.com/iris-eval/mcp-server](https://github.com/iris-eval/mcp-server). The package is at [npmjs.com/package/@iris-eval/mcp-server](https://www.npmjs.com/package/@iris-eval/mcp-server).

If you are running agents in production and flying blind, give Iris a look. If you find a bug or have a feature request, open an issue. Contributions are welcome.
