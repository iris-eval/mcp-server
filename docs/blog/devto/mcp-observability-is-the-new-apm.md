---
title: "MCP Observability is the New APM"
published: false
description: "In 2010, application performance monitoring was a nice-to-have. Engineering teams shipped to production, watched their server logs, and hoped for the best...."
tags: mcp, aiagents, observability, opensource
canonical_url: https://iris-eval.com/blog/mcp-observability-is-the-new-apm
---

In 2010, application performance monitoring was a nice-to-have. Engineering teams shipped to production, watched their server logs, and hoped for the best. Monitoring was a dashboard someone checked after an outage. APM vendors existed, but adoption was concentrated in the largest enterprises with the biggest budgets and the most painful incidents.

By 2015, the conversation had completely shifted. No serious engineering team shipped without Datadog, New Relic, or Sentry in their stack. APM was not a luxury anymore. It was infrastructure. The shift did not happen because the tools got dramatically better overnight. It happened because the systems they monitored got complex enough that operating without observability became professionally irresponsible.

I am watching the same inflection happen right now with AI agent observability. And most teams do not see it yet.

## The Complexity Threshold

APM became mandatory when web applications crossed a complexity threshold. Microservices replaced monoliths. Distributed systems replaced single servers. The number of failure modes multiplied faster than any team could track manually. At that point, "check the logs" stopped working as an operational strategy, and APM became the floor, not the ceiling.

AI agents have crossed an equivalent threshold. A single agent execution is not a request-response cycle. It is a multi-step workflow: the LLM reasons, selects tools, calls them in sequence or parallel, handles errors, retries, synthesizes results, and produces output. A single run might span 5 tool calls, 3 inference steps, 12,000 tokens, and $0.04 in cost. The execution path is non-deterministic. The same input can produce different tool call sequences on different runs.

This is not a web request. This is a distributed computation with stochastic components. And the tooling has not caught up to the complexity.

## Why Traditional APM Fails for Agents

APM tools monitor at the HTTP layer. They see requests, responses, status codes, latency. They are very good at answering "did this endpoint return a 500?" and "what is the p99 latency for this service?"

Agents operate at a different layer entirely. Call it the semantic layer. The relevant questions are not about HTTP status codes. They are about whether the agent's output is correct, complete, safe, and cost-efficient. APM cannot answer these questions because it does not understand what happened inside the agent's execution.

Here is the fundamental disconnect: your APM dashboard shows HTTP 200 across the board. Green lights everywhere. But the agent hallucinated an answer, leaked a phone number from its training data, spent $0.12 on a query that should cost $0.02, and silently dropped two retrieved documents that contradicted its reasoning. From the HTTP layer, everything is fine. From the semantic layer, everything is broken.

APM was built for a world where "the server responded successfully" was a meaningful health signal. In an agent world, "the server responded successfully" tells you almost nothing. The agent returned a response. Was it a good response? Was it a safe response? Did it actually use the tools it was supposed to? What did those tool calls return? How much did the whole thing cost? APM has no opinion on any of this.

This is not a criticism of APM. It is a recognition that agents are a fundamentally different class of system that requires a fundamentally different class of observability.

## What MCP-Native Observability Means

Most observability solutions for LLM applications follow the same pattern: import an SDK, wrap your function calls, push traces to an endpoint. This works, but it inherits a structural limitation. The instrumentation lives inside the agent's process. The agent's code decides what gets recorded. The agent's runtime decides what gets reported. If the agent fails, the instrumentation fails with it.

MCP changes this equation. In the Model Context Protocol, agents discover tools at runtime through a server registry. An agent does not hardcode its capabilities. It queries its configured MCP servers, discovers what tools are available, and invokes them through a standard protocol.

This means the observability tool can be a peer in the protocol, not a dependency in the agent's code. The agent discovers observability tools the same way it discovers any other tool. But the observability server runs in its own process, with its own storage, under its own control. No SDK to import. No wrapper functions to write. No instrumentation code to maintain across framework upgrades.

This is the equivalent of APM that auto-instruments without touching your application code. Except it goes further, because the observer is architecturally independent from the thing being observed. It is not a sidecar bolted onto the agent process. It is a separate server that the agent communicates with through the same protocol it uses for everything else.

Add an MCP observability server to your agent's config, and the agent gains tracing, evaluation, and querying capabilities on the next startup. Zero code changes. Zero dependency management. Zero framework-specific integration work. That is what protocol-native means.

## The Market is Forming Now

The observability market for LLM applications is real and growing. LangSmith, Langfuse, Helicone, Braintrust, Arize -- they are all building serious products for tracing, evaluating, and monitoring LLM-powered applications. The market has recognized that traditional APM is insufficient.

But every one of these solutions requires SDK integration. You import a library, instrument your code, and push data to their platform. This means per-framework integration work. It means your instrumentation breaks when you change agent frameworks. It means the agent process owns the observability pipeline.

None of them are protocol-native. None of them exist as peers inside the protocol that agents already speak. They are all, architecturally, bolted-on solutions -- good ones, but bolted on nonetheless.

MCP changes this equation because it provides a standard protocol layer where observability can live natively. An MCP observability server does not need to know which agent framework you are using. It does not need a framework-specific SDK. It does not care if you switch from one framework to another next month. It speaks the protocol. Any agent that speaks the same protocol can use it.

This is the same shift that happened in web infrastructure. Early monitoring was application-specific. You wrote custom logging for your PHP app, your Java app, your Python app. Then standards emerged -- HTTP, OpenTelemetry, Prometheus metrics -- and monitoring tools could work across the entire stack without application-specific integration. MCP is that standardization moment for agent observability.

## Category Ownership Matters

There is a pattern in developer tooling markets that is worth studying. Datadog did not win by being the best monitoring tool on every dimension. They won by defining "infrastructure monitoring" as a category and being the company most associated with it. When someone said "we need infrastructure monitoring," the next word was Datadog. The category and the company became synonymous.

Sentry did the same thing with error tracking. Stripe did it with developer payments. Twilio did it with communication APIs. In each case, the company that named and defined the category captured a disproportionate share of the market, even when technically comparable alternatives existed.

The same opportunity exists for MCP observability. Agent observability is becoming an obvious need. The protocol layer where it should live is standardizing around MCP. The category -- MCP-native agent observability -- is forming right now. The question is who defines it.

I do not think this is a market that will be won by the largest company or the best-funded startup. I think it will be won by whoever builds the tool that developers reach for first, the one that shows up in MCP configs across the ecosystem, the one that becomes the default answer to "how do I see what my agents are doing?"

## What This Means for Your Team

If you are deploying AI agents today, here is the practical takeaway: you need observability that understands agents, not just HTTP requests. And the sooner you start instrumenting, the sooner you build the dataset that makes your agents reliable.

Every agent execution you do not trace is a debugging session you cannot have later. Every output you do not evaluate is a quality regression you will not catch until a user reports it. Every cost you do not track is a budget surprise waiting to happen.

The teams that will ship reliable agents are not the ones with the most sophisticated models. They are the ones with the most visibility into what their agents are actually doing. The model is the engine. Observability is the instrument panel. You do not drive at highway speed without one.

The APM parallel is not a metaphor. It is a prediction. Within two years, shipping agents without observability will look as reckless as shipping a microservices architecture without monitoring looked in 2016. The inflection is happening now.

## Start Now

Iris is an open-source MCP-native observability server. Add it to your MCP config, and your agents gain tracing, evaluation, and cost tracking on the next startup. No SDK, no code changes.

```bash
npx @iris-eval/mcp-server --dashboard
```

The code is at [github.com/iris-eval/mcp-server](https://github.com/iris-eval/mcp-server). See what your agents are actually doing -- before the next outage makes the decision for you.
