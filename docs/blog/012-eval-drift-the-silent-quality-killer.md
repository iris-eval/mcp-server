---
title: "Eval Drift: The Silent Quality Killer for AI Agents"
description: "Eval drift is the silent degradation of agent quality caused by upstream model changes you can't control. Learn how to detect and prevent it."
date: 2026-03-22
author: Ian Parent
tags: [eval-drift, agent-eval, quality, mcp, vocabulary]
relatedPosts: [the-ai-eval-tax, self-calibrating-eval, the-eval-loop]
---

# Eval Drift: The Silent Quality Killer for AI Agents

Your agent worked perfectly last month. Your code hasn't changed. Your prompts are identical. But your users are complaining about quality, and you have no idea why.

Welcome to **eval drift** — the silent degradation of agent output quality over time, invisible to traditional monitoring, devastating in production.

## What Is Eval Drift?

Eval drift is what happens when your agent's quality scores decline without any change to your code, prompts, or infrastructure. Your dashboards show green. Your APM reports HTTP 200s. But the actual outputs — the things users see and depend on — are getting worse.

In traditional ML, we call this data drift or concept drift. The input distribution changes, or the world changes, and your model's predictions degrade. For LLM-based agents, both of those apply. But there's a third mechanism that's unique to the API-driven agent era: **provider drift**.

## The Provider Drift Problem

Upstream model providers — OpenAI, Anthropic, Google — update model weights, safety filters, and decoding parameters without public announcement. Your code stays identical. Your prompts stay identical. Outputs change anyway.

This is not theoretical. A [Stanford/Berkeley study](https://arxiv.org/abs/2307.09009) (Chen et al., 2023) evaluated GPT-4 across March and June 2023 on the same benchmarks. The results were alarming:

- Code generation accuracy dropped from **52% to 10%** — in three months
- Prime number identification accuracy dropped from 97.6% to 2.4% with chain-of-thought prompting
- Average response length for code tasks collapsed from ~821 characters to under 4

None of this was announced. No changelog. No API version bump. Developers whose products relied on March behavior were shipping broken products in June without knowing it.

In April 2025, OpenAI pushed an update to GPT-4o with no developer notification. When confronted, their response: "Training chat models is not a clean industrial process."

Your agent's quality is a function of a dependency you cannot pin, cannot version, and cannot control. This is one of the key mechanisms behind [the eval tax](/blog/the-ai-eval-tax) — the compounding cost of unscored outputs.

## The Scale of the Problem

This isn't an edge case. The data paints a clear picture:

- **91%** of ML models experience performance degradation over time ([Scientific Reports, 2022](https://www.fiddler.ai/blog/91-percent-of-ml-models-degrade-over-time))
- Without continuous monitoring, model performance commonly degrades significantly within months — often discovered only after users report quality issues

Every external LLM API is a live, mutating dependency. Every MCP tool call your agent makes today will produce different results next month — potentially worse results — and you won't know unless you're measuring.

## The Software Analogy

Think of it like a shared library that updates its behavior without changing its version number. In traditional software, we have semver precisely to prevent this. When a dependency changes, the version number tells you. You can pin versions. You can test upgrades.

With LLM APIs, there is no semver. There is no pinning. The dependency mutates under you, and the only way to know is to measure the outputs.

## How to Detect Eval Drift

The pattern is straightforward — if you have the infrastructure:

1. **Establish a baseline.** Run evals at deployment and record the scores.
2. **Continue scoring on every execution.** Not sampling. Every call.
3. **Track the trend.** A 7-day rolling average of quality scores should be flat or rising.
4. **Alert on degradation.** When the rolling average drops below baseline, something changed — and it wasn't your code.

Detecting drift requires [high eval coverage](/blog/eval-coverage-the-metric-your-agents-are-missing) — you cannot spot a trend in data you are not collecting. The critical insight: eval scores must be **persisted over time**. A point-in-time score tells you how your agent is doing right now. A time series tells you whether it's getting worse.

## What Iris Does About This

Iris persists every eval result with a timestamp to SQLite. The dashboard exposes eval score trends over time — quality scores bucketed by hour, day, or week. The rules breakdown surfaces which specific eval rules are failing most often, sorted by pass rate so the worst problems surface first.

When your agent's quality drifts, Iris makes it visible. A flat trend line means stable quality. A declining trend is the early warning that the industry currently lacks.

For the fastest detection, use [heuristic eval rules](/blog/heuristic-vs-semantic-eval) that run on every execution in sub-millisecond time, building the time-series data that makes drift visible. The alternative is finding out from your users. They'll notice before your monitoring does — unless your monitoring actually evaluates the outputs.

## The Bottom Line

Eval drift is not a bug in your code. It's a property of the environment your code runs in. Model providers will continue updating silently. The input distribution will continue shifting. The only defense is continuous evaluation — not once at deployment, not weekly spot checks, but on every execution, with scores persisted over time.

Name the problem. Measure it. That's how you stop it from killing your product in silence.

*For the complete picture, see our [Agent Eval: The Definitive Guide](/learn/agent-eval).*

---

*Iris is the agent eval standard for MCP. Any MCP-compatible agent can discover Iris's eval tools and invoke them inline — no SDK, no code changes. Try it: [iris-eval.com/playground](https://iris-eval.com/playground)*
