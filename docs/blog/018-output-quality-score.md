---
title: "Output Quality Score: The Single Number That Tells You If Your Agent Is Good Enough"
description: "Output Quality Score (OQS) is a composite metric that rolls completeness, relevance, safety, and cost into one number — giving teams a single quality signal for every agent output."
date: 2026-04-03
author: Ian Parent
tags: [output-quality-score, oqs, agent-eval, quality, mcp, vocabulary]
devto_tags: [ai, agenteval, programming, testing]
---

# Output Quality Score: The Single Number That Tells You If Your Agent Is Good Enough

Your agent runs 12 eval rules. Eight pass. Two are borderline. Two fail. Is the output good enough to ship?

Nobody can answer that question by staring at 12 individual scores. Not at 2 AM during an incident. Not in a Slack thread about whether the latest prompt change helped or hurt. Not in an executive review where someone asks "how are our agents doing?" and the answer is a spreadsheet.

You need one number. A composite. A rollup that absorbs the complexity of individual rules and produces a single signal: this output is good enough, or it isn't.

That number is the **Output Quality Score (OQS)**.

## What OQS Is

OQS is a weighted composite score that combines individual eval rule results into a single 0-to-1 number representing the overall quality of an agent output. It's calculated from scores across four dimensions:

- **Completeness** — Did the output address what was asked? Does it contain the required elements?
- **Relevance** — Is the output on-topic? Does it relate to the input context rather than drifting?
- **Safety** — Does the output avoid PII, prompt injection patterns, and policy violations?
- **Cost** — Did the execution stay within the acceptable token and dollar budget?

Each dimension contains one or more eval rules. Each rule produces a score. OQS rolls them up into a single number using configurable weights.

Think of it like a credit score for agent outputs. Your credit score is one number — but it's calculated from payment history, credit utilization, length of history, credit mix, and new inquiries. You don't need to understand the individual factors to use the score. The score tells you whether you qualify or you don't. OQS works the same way: one number, multiple factors, one decision.

## The Problem OQS Solves

Without a composite score, teams face the same pattern:

**The dashboard problem.** You've got a monitoring page showing 8 or 12 individual metrics. Completeness is 0.91. Relevance is 0.87. Safety is 1.0. Cost is 0.73. Is the agent healthy? You can't tell at a glance because there's no rollup. Every review becomes a manual scan of individual numbers.

**The alerting problem.** What do you alert on? Each metric individually? That's 12 alert channels with 12 thresholds to maintain. Most teams either alert on everything (noise) or alert on nothing (silence until an incident). A single composite score means a single alert threshold: OQS dropped below 0.80 — investigate.

**The trending problem.** Did last week's prompt change improve things? You'd have to compare 12 metrics across two time periods. OQS gives you one trend line. It went from 0.84 to 0.79. The change made things worse. Revert.

**The SLO problem.** You want to define a service level objective for agent quality. "99% of outputs must score above X." You can't define that X across 12 individual metrics without a composite. OQS is the metric that makes agent quality SLOs possible.

These aren't hypothetical scenarios. They're the operational reality of any team running agents in production without a rollup metric. The individual eval rules are essential for diagnosis — they tell you *what* is wrong. OQS tells you *whether* something is wrong.

## How OQS Is Calculated

The calculation is a weighted average of individual rule scores, with one critical modifier: safety rules have veto power.

```
OQS = Σ (rule_score × rule_weight) / Σ (rule_weight)

Exception: if any safety rule scores 0, OQS = 0
```

Default weights reflect the operational priority most teams converge on:

| Dimension | Default Weight | Rationale |
|-----------|---------------|-----------|
| Completeness | 0.30 | Core output quality |
| Relevance | 0.30 | On-topic accuracy |
| Safety | 0.25 | Hard constraints (veto on zero) |
| Cost | 0.15 | Efficiency within budget |

Safety's veto is the key design decision. A response can be incomplete and still be acceptable. A response that leaks PII is never acceptable regardless of how well it answered the question. The veto ensures that a perfect completeness score can't mask a safety failure — if safety is zero, OQS is zero.

Weights are configurable. A healthcare agent might weight safety at 0.40. A creative writing assistant might weight completeness at 0.50 and cost at 0.05. The defaults work for most agent use cases; the configurability exists because "most" isn't "all."

## OQS in Practice

Here's what OQS looks like when it's operational:

**Dashboard:** One number per agent, per time period. Green above 0.85, yellow 0.70-0.85, red below 0.70. You can see the health of every agent in production at a glance.

**Alerting:** `if oqs < 0.80 for 5 minutes → page on-call`. One rule. One threshold. One alert channel.

**Trend tracking:** OQS plotted over time shows the effect of every prompt change, model update, and config modification. When an upstream model provider pushes an update and your OQS drops from 0.88 to 0.76 overnight — that's [eval drift](/blog/eval-drift-the-silent-quality-killer) detected automatically.

**SLOs:** "99th percentile OQS must remain above 0.75." Now agent quality is a contract, not a feeling.

**Comparison:** Agent A has an OQS of 0.91. Agent B has an OQS of 0.72. Which one is production-ready? The question answers itself.

## How Iris Implements OQS

When you call `evaluate_output` through Iris, the response includes individual rule scores *and* an overall score — the OQS. You don't have to calculate it yourself. You don't have to decide on an aggregation strategy. The tool returns a single number alongside the breakdown.

```json
{
  "overall_score": 0.87,
  "rules": {
    "completeness_address_question": { "score": 0.92, "pass": true },
    "relevance_on_topic": { "score": 0.85, "pass": true },
    "safety_no_pii": { "score": 1.0, "pass": true },
    "cost_token_budget": { "score": 0.71, "pass": true }
  }
}
```

The `overall_score` is the OQS. Use it for dashboards. Use it for alerts. Use it for SLOs. When it drops, drill into the individual rule scores to diagnose why.

This is the metric that makes the rest of the vocabulary operational. [Eval-Driven Development](/blog/eval-driven-development) needs a target score to iterate toward — that's OQS. [Eval drift](/blog/eval-drift-the-silent-quality-killer) is detected by tracking OQS over time. [The eval gap](/blog/the-eval-gap) is quantified by comparing OQS in staging versus production. [Eval coverage](/blog/eval-coverage-the-metric-your-agents-are-missing) tells you what percentage of outputs have an OQS at all. OQS is the number that connects the entire evaluation practice together.

## The Alternative Is Worse

Without OQS, teams default to one of two failure modes:

**Mode 1: Metric overload.** Every individual rule gets its own dashboard panel, its own alert, its own threshold. Engineers spend more time interpreting metrics than fixing agents. Alert fatigue sets in. Eventually the dashboards get ignored.

**Mode 2: No metrics at all.** The team decides that 12 individual scores are too complex to operationalize, so they don't operationalize any of them. Quality is assessed by spot-checking. Regressions are found by customers. This is [the eval tax](/blog/the-ai-eval-tax) at maximum rate.

OQS eliminates both failure modes. One number. One threshold. One trend line. The individual rules exist for diagnosis. The composite exists for decision-making.

## Get Started

OQS is available today in Iris. Add it to your MCP config, call `evaluate_output`, and the overall score is in the response.

```bash
npx @iris-eval/mcp-server@latest
```

Try it in the playground: [iris-eval.com/playground](https://iris-eval.com/playground)

*For the complete picture, see our [Agent Eval: The Definitive Guide](/learn/agent-eval).*

---

*One number. Multiple factors. One decision. That's OQS.*

*Start scoring: [iris-eval.com/playground](https://iris-eval.com/playground)*
