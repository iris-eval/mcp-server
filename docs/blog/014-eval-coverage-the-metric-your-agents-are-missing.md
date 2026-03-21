---
title: "Eval Coverage: The Metric Your AI Agents Are Missing"
description: "Eval coverage measures the percentage of agent executions that receive evaluation. Most teams are at 0%. Here's why 100% is the only target."
date: 2026-03-26
author: Ian Parent
tags: [eval-coverage, agent-eval, testing, mcp, vocabulary]
---

# Eval Coverage: The Metric Your AI Agents Are Missing

Every serious codebase measures test coverage. CI pipelines enforce minimums. Pull requests get rejected when coverage drops. The industry spent two decades making this a standard practice.

For AI agents, the equivalent metric doesn't exist yet. It should. It's called **eval coverage** — the percentage of agent executions that receive an evaluation.

## The Current State: Nearly Zero

The numbers are stark. From [LangChain's State of Agent Engineering survey](https://www.langchain.com/state-of-agent-engineering) (1,340 respondents, late 2025):

- **Only 52%** of organizations run offline evaluations on test sets
- **Only 37%** run online evals on real production traffic
- **89%** have infrastructure observability — but observability tells you if the call completed, not if the answer was good
- Only a small minority of teams evaluate 90%+ of their production agent executions

The majority of companies building AI agents in production are running at effectively **0% eval coverage on live traffic.** They are paying [the eval tax](/blog/the-ai-eval-tax) on every unscored execution. They're shipping code without tests — except the code is non-deterministic, the failures are silent, and the consequences are user-facing.

## Why Agent Eval Coverage Is Different from Test Coverage

In traditional software, test coverage measures what percentage of code paths your test suite exercises. Tools like Istanbul and Coverage.py make this measurable. The industry settled on 80-85% as the pragmatic target — high enough to catch most regressions, not so exhaustive that tests cost more than the code they protect.

For AI agents, coverage is structurally different. **It's not about code paths — it's about executions.** An agent can have 100% code test coverage — every function tested — and still produce garbage outputs in production, because the behavior lives in the model's probability distribution, not in deterministic code.

This means coverage must be measured at the output level: what percentage of actual agent outputs were evaluated for quality, safety, and cost?

## Why 100% Eval Coverage Matters

In software, 80% test coverage is considered good. An uncovered branch might be dead code that never runs. But with agent outputs, there is no dead code. Every call is a real user interaction with real consequences.

Spot-checking 25% of runs is not "mostly covered." It means 75% of your production failures are invisible. The failure that leaks PII, the hallucination that sends a customer wrong data, the $40 API call that should have been $0.12 — these live in the long tail, and they're the ones that generate lawsuits, churn, and trust destruction.

## The Coverage Spectrum

| Level | What It Means | What You Miss |
|-------|---------------|---------------|
| **0%** | No eval, ever | Everything. Flying blind. |
| **25%** | Spot checks, manual review | 75% of failures invisible |
| **50%** | Sampling — eval 1-in-2 calls | Half your production failures |
| **80%** | What software considers "good" | 20% blind spots — still risky for agents |
| **100%** | Every execution evaluated inline | Full visibility. Drift detectable from day one. |

## The Test Coverage History Parallel

The journey from "tests are optional" to "shipping without tests is unprofessional" took about 15 years:

- **1994:** Kent Beck published SUnit — the first test framework formalization
- **1999:** Extreme Programming codified TDD as a core practice
- **2003:** "TDD: By Example" published — the codification artifact
- **2005-2010:** CI/CD adoption made test gates structural, not optional
- **2010+:** Not having tests became a professional red flag
- **Today:** 80%+ coverage is expected in any serious codebase

A joint [IBM and Microsoft study](https://www.microsoft.com/en-us/research/wp-content/uploads/2009/10/Realizing-Quality-Improvement-Through-Test-Driven-Development-Results-and-Experiences-of-Four-Industrial-Teams-nagappan_tdd.pdf) shows TDD reduces post-release bugs by 40-90%.

Where are we with agent eval? Somewhere around 1999. The practice exists. A few leading teams use it. The tooling is emerging. The industry standard hasn't formed yet.

History is about to rhyme. The discipline that accelerates adoption is [Eval-Driven Development](/blog/eval-driven-development) — writing eval rules before prompts, the same way TDD writes tests before code.

## How to Get to 100%

The reason most teams run at 0% eval coverage is that adding per-call evaluation is manual, fragile, and easy to forget. As we show in [How to Evaluate Agent Output Without Calling Another LLM](/blog/how-to-evaluate-agent-output-without-llm), heuristic rules make per-call evaluation fast and free enough to run on every execution. The same reason test coverage was low before CI made it structural.

The path to 100% follows the same pattern:

1. **Make it structural, not discretionary.** If evaluation requires developers to add per-call instrumentation, coverage will always be incomplete. If evaluation is built into the protocol layer — the communication channel every agent already uses — coverage is automatic.

2. **Measure it.** You can't improve what you don't measure. Track your eval coverage as a metric: (evaluated executions / total executions) × 100.

3. **Alert on drops.** When eval coverage drops below 100%, something is misconfigured. Treat it like test coverage: a metric that goes in one direction.

## The Iris Approach

Iris enables high eval coverage by integrating at the MCP protocol layer. Agents call Iris eval tools inline — the same way they call any other MCP tool — keeping evaluation within the agent's own workflow rather than requiring a separate instrumentation pass.

The architectural advantage: when eval is an MCP tool the agent can invoke on any output, adding coverage doesn't require per-call instrumentation in your application code. You configure Iris once, and the agent has access to eval on every execution.

This is why the coverage framing matters: protocol-native eval makes high coverage a matter of agent configuration, not developer discipline. The same way CI pipelines made test coverage structural, MCP-native eval makes agent eval coverage structural.

---

*Iris is the agent eval standard for MCP. Add it to your MCP config and start scoring agent outputs inline. Try it: [iris-eval.com/playground](https://iris-eval.com/playground)*
