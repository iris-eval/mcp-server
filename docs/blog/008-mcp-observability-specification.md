---
title: "Toward an MCP Observability Specification"
description: "A proposal for standardizing MCP observability with trace schemas, eval interfaces, and cost metadata to prevent ecosystem fragmentation."
date: 2026-03-16
author: Ian Parent
tags: [mcp, observability, specification, protocol, eval, traces, interoperability]
relatedPosts: [state-of-mcp-agent-observability-2026, mcp-observability-is-the-new-apm, mcp-meets-opentelemetry]
---

# Toward an MCP Observability Specification

The Model Context Protocol defines how agents discover and invoke tools. It defines resources, prompts, and transport mechanisms. It standardizes the interface between an agent and the capabilities it can use. This is significant work, and it has enabled an ecosystem of interoperable MCP servers to emerge in a short time.

But MCP does not define how agents should report what they did.

There is no standard trace format. No standard eval interface. No standard way to express cost metadata, token usage, or span relationships. Every observability solution in the MCP ecosystem — including Iris — is bolted on after the fact. We build our own schemas, define our own tool interfaces, and store data in our own formats. The protocol that standardized tool invocation has nothing to say about tool observation.

I think this is a gap worth closing. This post is a sketch of what an MCP observability specification could look like, grounded in what I have learned building Iris as an MCP-native observability server.

## The Missing Primitive

The MCP spec, as of March 2026, defines four core primitives:

- **Tools**: Functions that agents can invoke, with typed input/output schemas.
- **Resources**: Data that agents can read, identified by URI.
- **Prompts**: Templated instructions that agents can discover and use.
- **Transport**: The communication layer (stdio, HTTP with SSE, Streamable HTTP).

These primitives cover what agents can do and how they communicate. They do not cover what agents did. There is no `trace` primitive. No `eval` primitive. No standard metadata field for cost or token usage on tool call responses. The protocol is expressive about capabilities and silent about accountability.

This is not an oversight in the sense that anyone forgot. Observability is genuinely hard to standardize because it touches everything — spans, metrics, logs, evaluations, cost attribution. But the absence of even a minimal observability primitive means that the ecosystem is fragmenting before it has a chance to converge.

## What Fragmentation Looks Like in Practice

Today, if you want observability for MCP agents, you have several options. Each defines its own schema.

A trace in one tool might look like a flat JSON object with `input`, `output`, `latency_ms`, and a `tool_calls` array. A trace in another might use OpenTelemetry span conventions with `traceId`, `spanId`, `parentSpanId`, and attribute maps. A third might use a proprietary event stream format optimized for their cloud backend.

The result: traces from tool A cannot be compared to traces from tool B. You cannot export from one and import to another. If you switch observability providers, you lose your historical data or write a custom migration. If you want to aggregate traces across multiple observability tools — say, one team uses one provider and another team uses a different one — you are writing glue code.

This is the state of agent observability in early 2026. Every tool has reasonable internal design. None of them interoperate. And the protocol that could provide a shared foundation says nothing about it.

## What a Spec Could Look Like

I am not proposing a complete specification here. I am proposing that the MCP community start discussing one, and offering a concrete sketch based on what I have learned implementing observability as MCP tools. Here are four additions to the MCP specification that I think would make observability a first-class concern.

### 1. A Standard Trace Schema

The spec should define a minimal trace object that any MCP-compatible observability tool can produce and consume. Something like:

```json
{
  "mcp_trace": {
    "version": "0.1",
    "trace_id": "uuid",
    "agent_name": "string",
    "timestamp_start": "iso8601",
    "timestamp_end": "iso8601",
    "input": "string",
    "output": "string",
    "spans": [
      {
        "span_id": "uuid",
        "parent_span_id": "uuid | null",
        "tool_name": "string",
        "tool_server": "string",
        "input": "object",
        "output": "object",
        "started_at": "iso8601",
        "ended_at": "iso8601",
        "status": "ok | error",
        "metadata": {}
      }
    ],
    "token_usage": {
      "prompt_tokens": "number",
      "completion_tokens": "number",
      "total_tokens": "number"
    },
    "cost": {
      "total_usd": "number",
      "model": "string"
    },
    "metadata": {}
  }
}
```

This is not a new idea. OpenTelemetry solved this for distributed services a decade ago, and as we explore in [MCP Meets OpenTelemetry](/blog/mcp-meets-opentelemetry), the structural mapping between agent traces and OTel spans is surprisingly natural. The MCP trace schema does not need to reinvent span trees or trace context propagation. It needs to define what a trace means in the context of an agent making tool calls through MCP, with the fields that matter for agent-specific concerns: token usage, cost, model identity, and the relationship between agent reasoning and tool invocations.

The `metadata` field on both the trace and individual spans allows tools to extend the schema without breaking interoperability. The core fields are the contract. Everything else is optional enrichment.

### 2. A Standard Eval Interface

Evaluation is where fragmentation is most acute. Every eval tool defines its own rule format, its own scoring schema, and its own way of associating scores with traces.

The spec should define a standard tool interface for evaluation:

```json
{
  "name": "mcp_eval",
  "inputSchema": {
    "type": "object",
    "properties": {
      "trace_id": { "type": "string" },
      "output": { "type": "string" },
      "rules": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "rule_id": { "type": "string" },
            "category": { "type": "string", "enum": ["completeness", "relevance", "safety", "cost", "custom"] },
            "threshold": { "type": "number" }
          }
        }
      }
    }
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "trace_id": { "type": "string" },
      "scores": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "rule_id": { "type": "string" },
            "score": { "type": "number", "minimum": 0, "maximum": 1 },
            "pass": { "type": "boolean" },
            "details": { "type": "string" }
          }
        }
      },
      "aggregate_score": { "type": "number" }
    }
  }
}
```

The key insight: the eval interface standardizes the contract, not the implementation. One tool might use [heuristic regex matching](/blog/heuristic-vs-semantic-eval). Another might use LLM-as-judge. A third might call out to a custom model. The spec defines what goes in and what comes out. How the scoring happens is the implementer's concern.

This means eval results from different tools are structurally comparable. A `safety` score of 0.85 from tool A and a `safety` score of 0.72 from tool B use the same schema, even if their internal methods differ. You can aggregate them, trend them, alert on them — without writing adapters.

### 3. A Standard Cost Metadata Field on Tool Responses

This is the smallest change with the largest practical impact. When an MCP tool returns a response, the spec currently defines the response content (text, images, embedded resources). It does not define a place for operational metadata.

I propose adding an optional `_mcp_meta` field to tool call responses:

```json
{
  "content": [{ "type": "text", "text": "..." }],
  "_mcp_meta": {
    "token_usage": {
      "prompt_tokens": 1200,
      "completion_tokens": 450
    },
    "cost_usd": 0.0087,
    "model": "claude-sonnet-4-20250514",
    "latency_ms": 1340
  }
}
```

Today, if an MCP tool wraps an LLM call internally, the token usage and cost are invisible to the calling agent and to any observability layer. The tool returns its output, and the operational cost is a black box. Adding a standard metadata field means observability tools can aggregate cost across the entire agent execution — not just the top-level LLM call, but every tool that makes its own LLM calls under the hood.

Building Iris, this was one of the most requested capabilities. Teams want to know: what is this agent costing me? Not just the prompt tokens I can see, but the total cost across every tool in the chain. Without a standard place to report this, cost aggregation requires per-tool custom integration.

### 4. Standard Resource URIs for Observability Data

MCP resources use URIs. Iris already uses this pattern — agents can read `iris://dashboard/summary` to get a structured overview of recent traces and scores. But the URI scheme and the data format are Iris-specific.

The spec should reserve a URI scheme (or path convention) for observability resources:

```
mcp-trace://traces/latest
mcp-trace://traces/{trace_id}
mcp-trace://dashboard/summary
mcp-trace://evals/{trace_id}
mcp-trace://costs/aggregate?window=24h
```

Any MCP-compatible observability tool that implements these URIs becomes queryable in a standard way. An agent could read `mcp-trace://traces/latest` from any observability server and get back a structurally identical response, regardless of which tool is providing the data.

This is the interoperability layer. Standardized URIs mean agents, dashboards, and downstream tools can consume observability data without knowing which specific provider is behind it.

## What Iris Learned Building This

I want to be specific about what we ran into while implementing trace logging, eval scoring, and cost tracking as MCP tools, because these are the friction points that a spec would address.

**Trace schema design is full of tradeoffs.** Early versions of Iris used a flat trace format — one object per agent execution, with tool calls as a nested array. This broke down when agents called tools that called other tools. We moved to a span tree model, inspired by OpenTelemetry, with parent-child relationships between spans. The span tree is more expressive, but it is also more complex to query and display. A spec needs to support both simple (flat) and complex (hierarchical) trace structures without requiring the complex case upfront.

**Eval scoring needs a bounded, comparable scale.** We settled on 0-to-1 scores with a boolean pass/fail derived from configurable thresholds. This was not obvious at first — early versions used unbounded scores, percentage scales, and letter grades at various points. The 0-to-1 normalized scale is the only one that composes cleanly across rules and categories. A spec should mandate it.

**Cost tracking is impossible without cooperation from tool servers.** If a tool server does not report its token usage, the observability layer cannot infer it. You can track the tokens the agent uses at the top level, but the cost of tools that make their own LLM calls is invisible. This is why the `_mcp_meta` field matters — it turns cost reporting from a favor into a convention.

**Resource URIs are powerful but underdiscovered.** MCP resources are one of the most underused parts of the protocol. Agents can read structured data from resources just like they invoke tools. For observability, this means agents can self-monitor by reading their own trace history — useful for agents that need to detect their own error patterns or adjust behavior based on past performance. But without standard URIs, every observability tool invents its own scheme, and agents cannot be written to work with generic observability resources.

## Why This Matters Now

The MCP ecosystem is growing fast. More servers, more agents, more production deployments. The observability gap is going to widen, not narrow, as adoption increases. Every new observability tool that launches will define its own schema, its own eval interface, its own cost format. The longer the ecosystem goes without a standard, the harder convergence becomes.

There is a window right now — while the ecosystem is still young enough that a specification can influence implementations rather than chase them. OpenTelemetry succeeded in part because it arrived before the observability ecosystem fully fragmented. The MCP observability ecosystem is at that same inflection point.

## Next Steps

This post is a starting point, not a finished proposal. The specifics — field names, URI schemes, versioning strategy, backward compatibility — all need community input.

What I am asking for:

1. **Recognition** that observability is a first-class concern for the MCP specification, not something to be handled entirely by third-party tools.
2. **Discussion** about which primitives belong in the spec versus which should be left to implementers.
3. **Collaboration** on a minimal viable observability spec that tool authors can adopt incrementally.

If you are building MCP tools, agent frameworks, or observability infrastructure, I want to hear what you have run into. What schema decisions have you made? What interoperability problems have you hit? What would a standard need to include for you to adopt it?

Without standardization, the fragmented ecosystem will make it harder to achieve the [eval coverage](/blog/eval-coverage-the-metric-your-agents-are-missing) that production agents need. The conversation is happening on [GitHub Discussions](https://github.com/iris-eval/iris/discussions) and in the [MCP Discord](https://discord.gg/mcp). Open an issue, start a thread, or reach out directly. The spec will be better if it reflects the experience of everyone building in this space, not just one team's perspective.

Observability that is protocol-native starts with a protocol that takes observability seriously. This is a proposal that it should.
