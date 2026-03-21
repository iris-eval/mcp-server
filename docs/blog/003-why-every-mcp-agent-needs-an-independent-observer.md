---
title: "Why Every MCP Agent Needs an Independent Observer"
description: "Why self-reported agent logs are structurally untrustworthy and how MCP enables architecturally independent observability for AI agents."
date: 2026-03-15
author: Ian Parent
tags: [observability, agents, mcp, architecture, trust]
---

# Why Every MCP Agent Needs an Independent Observer

There is a sentence I keep coming back to. I first saw it from @aginaut on X:

> "If the agent controls the logs, the logs are fiction."

That line stuck because it names a problem I had been circling for months while building agent infrastructure. The problem is not that agents are malicious. The problem is that self-reported behavior is structurally untrustworthy, and most agent deployments treat it as ground truth anyway.

## The Self-Reporting Problem

When an agent logs its own behavior, the logging is downstream of the agent's own reasoning. The agent decides what to record, when to record it, and what to omit. This is true even when the agent is "trying" to be accurate. LLMs summarize. They compress. They confabulate. These are features of the architecture, not bugs in a particular model.

Consider a concrete scenario. You have a support agent that retrieves docs, synthesizes an answer, and logs its execution. The agent reports: retrieved 3 documents, generated a response, latency 1.2 seconds, no errors. The log looks clean. But here is what actually happened:

- The retrieval returned 5 documents. The agent silently dropped 2 because they contradicted its initial reasoning.
- The response included a phone number from the training data, not from the retrieved documents.
- The agent spent 800ms on a retry loop after the first retrieval call timed out, but only reported the successful attempt.

None of this is visible in the agent's self-report. The agent did not "lie." It reported what it understood about its own execution. But an agent's understanding of its own execution is a lossy compression of what actually happened. These invisible failures are exactly the kind that traditional error trackers miss, as we explore in [Agent Errors vs Application Errors](/blog/agent-errors-vs-application-errors).

This is not a hypothetical. I have seen this pattern in production agent deployments. The traces look clean. The outputs have problems. And the gap between the two makes debugging nearly impossible.

## Separation of Concerns: A Distributed Systems Lesson

This problem has a well-known solution in distributed systems: you do not let a service monitor itself.

Your application server does not run its own health checks and report them to itself. Prometheus scrapes metrics from the outside. Your load balancer performs independent health probes. Your error tracking service (Sentry, Bugsnag) captures exceptions through an independent pipeline. The monitoring system is architecturally separate from the thing being monitored.

The reason is not that application servers are untrustworthy. The reason is that a system reporting on its own health has a conflict of interest at the structural level. If the application is in a degraded state, its self-monitoring might be degraded too. If it crashes, its self-reported logs stop. If it enters a pathological loop, its own metrics reflect the loop's perspective, not the external reality.

This principle — separation of concerns between the observed and the observer — is foundational to reliable infrastructure. We enforce it everywhere except, apparently, in AI agents.

Most agent observability today works like this: the agent imports an SDK, wraps its own function calls, and pushes traces to an endpoint. The agent is still in the critical path. The agent's code decides what gets instrumented. The agent's runtime decides what gets reported. The observer and the observed are the same process.

## MCP Changes the Architecture

The Model Context Protocol makes a different architecture possible. In MCP, agents discover tools at runtime through a server registry. An agent does not hardcode which tools it can use. It queries its configured MCP servers, discovers their capabilities, and invokes them.

This means observability can be an independent MCP server — a peer in the protocol, not a library inside the agent's process. The agent discovers the observability tools the same way it discovers any other tool. But the observability server runs in its own process, with its own storage, under its own control.

Here is what the configuration looks like:

```json
{
  "mcpServers": {
    "iris": {
      "command": "npx",
      "args": ["@iris-eval/mcp-server"]
    },
    "your-tools": {
      "command": "node",
      "args": ["./your-tool-server.js"]
    }
  }
}
```

Two servers. One is the agent's tool provider. The other is the observer. They are architecturally independent. The agent interacts with both through the same protocol, but the observability server does not depend on the agent's code, runtime, or cooperation to function correctly.

When the agent calls `log_trace`, it is reporting to an external system, not to itself. When the observability server runs `evaluate_output`, it is applying its own rules to the agent's output — not asking the agent to evaluate itself. When you query traces later with `get_traces`, you are reading from the observer's database, not the agent's memory.

This is the distributed systems pattern applied to agents. The observer is independent of the observed.

## What This Looks Like in Practice

I built Iris as an MCP server specifically because of this architectural principle. Add it to your MCP config, and every MCP-compatible agent — Claude Desktop, Cursor, Claude Code, custom agents built with the MCP SDK — discovers it on startup.

The agent gains three tools without any code changes:

**`log_trace`** records the full execution path:

```json
{
  "agent_name": "research-bot",
  "input": "Summarize Q4 earnings for Acme Corp",
  "output": "Acme Corp reported revenue of...",
  "tool_calls": [
    { "tool_name": "search_filings", "input": "Acme Corp Q4 2025", "output": "..." },
    { "tool_name": "extract_financials", "input": "...", "output": "..." }
  ],
  "latency_ms": 3400,
  "token_usage": { "prompt_tokens": 1800, "completion_tokens": 650, "total_tokens": 2450 },
  "cost_usd": 0.0187
}
```

**`evaluate_output`** runs deterministic checks against the agent's output — PII detection, prompt injection patterns, cost thresholds, completeness heuristics — and returns scores. The agent does not grade its own work. The observer does.

**`get_traces`** lets you query the observer's data after the fact, filtered by agent, time range, score, or cost.

The critical detail: Iris runs in its own process. It writes to its own SQLite database at `~/.iris/iris.db`. The agent cannot modify, delete, or selectively omit traces after the fact. The observer's record is independent of the agent's state.

For networked deployments where you want the observer even further separated from the agent's environment:

```json
{
  "mcpServers": {
    "iris": {
      "url": "http://your-iris-host:6920/mcp"
    }
  }
}
```

Now the observer runs on different infrastructure entirely. The agent reports to it over HTTP. The separation is not just logical — it is physical.

## The Infrastructure Gap Nobody Is Filling

LangChain, Google, Anthropic, Microsoft — they are all shipping agent frameworks and platforms. The pace is accelerating. But none of them ship protocol-native observability. None of them provide an independent observer that lives inside the protocol agents already speak.

The current observability options for MCP agents fall into two buckets:

**SDK instrumentation.** Import a library, wrap your calls, push to a vendor. This works, but the agent's code is still in the critical path. You instrument per-framework, per-agent. And the agent process owns the instrumentation — if it fails, the logs fail with it.

**Log aggregation.** Pipe stdout to Elasticsearch or CloudWatch. You get text. You lose structure. No span trees, no tool-call attribution, no cost aggregation. Searching logs for "what did the agent do at 3:47 PM" is archaeology, not observability.

What is missing is a third option: an independent MCP server that agents discover through the protocol, that runs in its own process, that stores traces in its own database, and that evaluates agent output using its own rules. Protocol-native, architecturally independent observability. And as we discuss in [MCP Meets OpenTelemetry](/blog/mcp-meets-opentelemetry), this independent observer can also bridge into your existing infrastructure monitoring stack.

This is the gap. It exists because agent frameworks are focused on the agent side of the problem — how to build agents, how to orchestrate them, how to give them tools. The observation side is treated as an afterthought. Add some logging. Bolt on an SDK. Ship it.

But observability that is bolted on inherits the agent's failure modes. Observability that is architecturally independent does not.

## The Trust Argument

There is a deeper point here about trust in agent systems. As agents take on more consequential tasks — managing customer data, making financial decisions, controlling infrastructure — the question "can we verify what this agent did?" becomes critical.

Self-reported logs do not provide verification. They provide the agent's account of events. An independent observer provides corroboration. The distinction matters for debugging, for auditing, and increasingly for compliance (the EU AI Act's traceability requirements take effect in August 2026).

The pattern is the same one that makes independent audits credible in finance, independent testing credible in engineering, and independent monitoring credible in infrastructure. Independence is not about distrust. It is about structural integrity.

## Try It

Iris is open-source, MIT licensed. One install, one config change, and your MCP agents have an independent observer.

```bash
npx @iris-eval/mcp-server --dashboard
```

The code is at [github.com/iris-eval/mcp-server](https://github.com/iris-eval/mcp-server). Star the repo, open an issue, or just add it to your MCP config and see what your agents are actually doing.

If the agent controls the logs, the logs are fiction. Give your agents an independent observer. Try the [Iris Playground](/playground) to see independent evaluation in action.
