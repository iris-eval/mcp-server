---
title: "MCP Meets OpenTelemetry: Bridging Agent Observability and Infrastructure Monitoring"
description: "How Iris bridges agent observability and infrastructure monitoring by exporting MCP traces as OpenTelemetry spans to Datadog and Grafana."
date: 2026-03-17
author: Ian Parent
tags: [opentelemetry, observability, mcp, infrastructure, datadog, grafana, agents, tracing]
---

# MCP Meets OpenTelemetry: Bridging Agent Observability and Infrastructure Monitoring

There are two worlds in production observability right now, and they do not talk to each other.

The first world is infrastructure monitoring. Prometheus scrapes metrics. OpenTelemetry collectors ship traces and logs to Datadog, Grafana Tempo, Jaeger. Your SRE team has dashboards for p99 latency, error rates, throughput. This stack is mature. It works. Teams have spent years building runbooks around it.

The second world is agent observability. What did the LLM actually do? Did it hallucinate? Did it drop context? How much did this execution cost? What was the eval score? These questions live in a completely separate tool -- a different dashboard, a different data model, a different team.

I have been building Iris, an MCP-native agent eval and observability tool, for the past several months. The more I work with production agent deployments, the more convinced I am that these two worlds need to merge. Not eventually. Now.

## The Two-Dashboard Problem

Here is a scenario I have seen play out at least three times in the last two months.

An agent starts producing bad outputs. The agent team opens their observability tool and sees that hallucination markers spiked at 2:47 PM. Eval scores dropped from 0.91 to 0.54. They start debugging the prompt, the retrieval pipeline, the model configuration.

Meanwhile, the infra team sees a different picture. Their Datadog dashboard shows that the vector database latency crossed 500ms at 2:45 PM. The retrieval endpoint started timing out. The connection pool hit its limit.

Neither team has the full picture. The agent team is debugging a hallucination. The infra team is debugging a latency spike. This is the [independent observer problem](/blog/why-every-mcp-agent-needs-an-independent-observer) applied to cross-team visibility. The actual root cause -- degraded retrieval causing the agent to fall back on parametric knowledge instead of retrieved context -- is only visible if you can correlate both signals.

This is not a tooling problem. It is an architectural one. Agent traces and infrastructure traces live in different systems with different schemas, different time bases, and no shared identifiers. There is no way to click from a hallucination in the agent dashboard to the infrastructure event that caused it.

## Why OTel Is the Bridge

OpenTelemetry has become the standard for infrastructure observability. Not because it is the best at any single thing, but because it is the lingua franca. Datadog speaks OTel. Grafana speaks OTel. Jaeger, Honeycomb, New Relic -- they all ingest OTel traces. If you can emit an OTel span, your data can flow into any of these backends.

The question is whether agent traces can be represented as OTel spans without losing the semantics that make them useful. After working through this for Iris, I believe the answer is yes -- and the mapping is more natural than I expected.

## How Iris Spans Map to OTel

Iris already uses an OTel-compatible span structure. This was a deliberate design choice. Here is what an Iris span looks like:

```json
{
  "span_id": "a1b2c3d4e5f6a7b8",
  "trace_id": "0f1e2d3c4b5a69780f1e2d3c4b5a6978",
  "parent_span_id": "9f8e7d6c5b4a3210",
  "name": "llm_call",
  "kind": "LLM",
  "status_code": "OK",
  "status_message": null,
  "start_time": "2026-03-17T14:30:00.000Z",
  "end_time": "2026-03-17T14:30:03.200Z",
  "attributes": {
    "model": "claude-sonnet-4-20250514",
    "prompt_tokens": 1800,
    "completion_tokens": 650,
    "cost_usd": 0.0187
  },
  "events": [
    {
      "name": "retrieval_fallback",
      "timestamp": "2026-03-17T14:30:01.100Z",
      "attributes": { "reason": "timeout", "retrieved_docs": 0 }
    }
  ]
}
```

Now here is the same span expressed as an OTel protobuf span:

```protobuf
Span {
  trace_id:       bytes(0f1e2d3c4b5a69780f1e2d3c4b5a6978)
  span_id:        bytes(a1b2c3d4e5f6a7b8)
  parent_span_id: bytes(9f8e7d6c5b4a3210)
  name:           "llm_call"
  kind:           SPAN_KIND_INTERNAL
  status:         { code: STATUS_CODE_OK }
  start_time_unix_nano: 1742221800000000000
  end_time_unix_nano:   1742221803200000000
  attributes: [
    { key: "iris.span.kind",        value: "LLM" },
    { key: "llm.model",             value: "claude-sonnet-4-20250514" },
    { key: "llm.usage.prompt_tokens",      value: 1800 },
    { key: "llm.usage.completion_tokens",  value: 650 },
    { key: "iris.cost_usd",         value: 0.0187 }
  ]
  events: [
    {
      name: "retrieval_fallback"
      time_unix_nano: 1742221801100000000
      attributes: [
        { key: "reason",         value: "timeout" },
        { key: "retrieved_docs", value: 0 }
      ]
    }
  ]
}
```

The structural mapping is nearly one-to-one:

| Iris Field | OTel Field | Notes |
|---|---|---|
| `trace_id` | `trace_id` | Iris uses 32 hex chars (16 bytes). OTel expects 16 bytes. Direct match. |
| `span_id` | `span_id` | Iris uses 16 hex chars (8 bytes). OTel expects 8 bytes. Direct match. |
| `parent_span_id` | `parent_span_id` | Same structure. Null for root spans. |
| `name` | `name` | String. Identical. |
| `kind` | `kind` + `attributes` | OTel has 5 span kinds (CLIENT, SERVER, INTERNAL, PRODUCER, CONSUMER). Iris adds LLM and TOOL as attribute values. |
| `status_code` | `status.code` | UNSET, OK, ERROR map directly. |
| `start_time` / `end_time` | `start_time_unix_nano` / `end_time_unix_nano` | ISO 8601 to nanosecond Unix timestamp. Straightforward conversion. |
| `attributes` | `attributes` | Key-value pairs. Iris uses JSON objects, OTel uses typed key-value arrays. |
| `events` | `events` | Timestamped events with attributes. Same semantics, different serialization. |

This structural compatibility is why we proposed standard trace schemas in [Toward an MCP Observability Specification](/blog/toward-an-mcp-observability-specification). The only real gap is span kind. OTel does not have native `LLM` or `TOOL` span kinds. The emerging [Semantic Conventions for LLM](https://opentelemetry.io/docs/specs/semconv/gen-ai/) handle this by using `INTERNAL` as the span kind and putting the semantic type in attributes like `gen_ai.operation.name`. Iris can adopt the same convention at export time without losing information.

## The Export Path

The Iris v0.4 roadmap includes OpenTelemetry trace export. Here is what this means in practice.

Iris continues to store traces locally in SQLite. That does not change. But it also exports spans to an OTel collector endpoint using the OTLP protocol. From the collector, traces flow into whatever backend you already run -- Datadog, Grafana Tempo, Jaeger, Honeycomb.

The architecture looks like this:

```
MCP Agent --> Iris MCP Server --> SQLite (local storage)
                 |
                 +--> OTLP Export --> OTel Collector --> Datadog / Grafana / Jaeger
```

This is not an either/or. Iris remains your agent-specific observability layer with eval scoring, cost tracking, and the span tree dashboard. But the raw trace data also flows into your infrastructure monitoring stack. The agent team keeps their Iris dashboard. The infra team sees agent spans in their Grafana dashboard. Same data, two views, shared trace IDs.

The shared trace ID is the key. When an Iris span has the same `trace_id` as the HTTP spans from your API gateway, you can click from the agent hallucination to the infrastructure event in a single trace waterfall. The correlation is structural, not a manual join across two systems.

## What This Unlocks

Once agent traces live alongside infrastructure traces, you can answer questions that neither system can answer alone.

**Root cause across layers.** The hallucination rate spiked because retrieval latency crossed 500ms, which happened because the vector database's read replica fell behind. You see this in one trace: the agent span, the retrieval tool span, and the database query span, all in the same waterfall.

**Cost attribution to infrastructure.** Your agent's cost per execution tripled last Tuesday. Was it a prompt change? No -- the Iris trace shows the same token count. The infrastructure traces show the retrieval endpoint started returning larger payloads after an index rebuild. More context in, more tokens out, higher cost. You would never find this in the agent dashboard alone.

**SLA monitoring that includes quality.** Your infrastructure SLA says p99 latency under 2 seconds. Your agent SLA should also say eval score above 0.8, a metric that naturally degrades over time through what we call [eval drift](/blog/eval-drift-the-silent-quality-killer). With both in the same system, you can build a single SLA dashboard that covers latency, availability, and output quality. When the SLA is breached, the alert includes both the infrastructure metric and the eval score.

**Anomaly correlation.** Your anomaly detection system flags a cluster of agent failures at 3 AM. The infrastructure traces show a certificate rotation happened at 2:58 AM. The agent traces show tool calls to an external API started failing at 3:01 AM. The connection is immediate when both signal types are in the same backend.

## Where This Is Going

The future I am building toward is simple to describe: agent traces flow alongside HTTP traces, database query traces, and message queue traces in the same observability backend. The agent is not a special case. It is another service in your distributed system, and it gets the same observability treatment.

This means you open Grafana and see a trace that starts at the API gateway, passes through your orchestration service, enters the agent, fans out to LLM calls and tool invocations, and returns through the same path. Every span has timing, status, and attributes. The agent spans also carry eval scores, cost data, and quality signals. All in one view.

We are not there yet. Iris today stores traces locally and serves them through its own dashboard. The OTel export in v0.4 is the bridge. Once Iris traces are in your OTel pipeline, the integration with existing dashboards, alerts, and runbooks follows naturally.

If you are running agents in production and you already have a Datadog or Grafana deployment, this is the path to unified observability. Not replacing your monitoring stack. Extending it to cover the agent layer.

Iris is open-source, MIT licensed. The code is at [github.com/iris-eval/mcp-server](https://github.com/iris-eval/mcp-server). Add it to your MCP config today, and when v0.4 ships, your agent traces will flow directly into the monitoring stack you already trust.

```bash
npx @iris-eval/mcp-server --dashboard
```

The infrastructure team and the agent team should not need separate dashboards to debug the same incident. That is the problem. OTel export is the bridge.
