---
title: "Closing the Eval Gap: From Lenient Defaults to Signal That Matters"
description: "Default eval thresholds are designed to catch catastrophe, not degradation. Here's how configurable thresholds and smarter rule exclusion turn your evals from rubber stamps into real quality gates."
date: 2026-04-14
author: Ian Parent
tags: [eval-gap, agent-eval, thresholds, quality, mcp, configuration]
relatedPosts: [the-eval-gap, self-calibrating-eval, output-quality-score]
devto_tags: [ai, agenteval, programming, testing]
---

# Closing the Eval Gap: From Lenient Defaults to Signal That Matters

In the [original Eval Gap post](/blog/the-eval-gap), we laid out the problem: the distance between "works in demo" and "works in production" kills AI products. Four mechanisms create the gap — narrow demo inputs, compound failure at scale, context contamination, and cost reality.

Today we're talking about a fifth mechanism. A quieter one. The one where your evals tell you everything is fine when it isn't.

## The Lenient Default Problem

Every eval framework ships with defaults. They have to. You can't ask new users to configure 12 thresholds before they see their first score. So the defaults are lenient — designed to catch catastrophic failure, not gradual degradation.

The result: your eval suite runs, your pass rate looks healthy, and your team develops a false confidence that quality is being monitored. But the thresholds are so permissive that the evals never fail unless something goes completely wrong.

Consider a completeness check that passes any output longer than 10 characters. Or a keyword overlap threshold of 20% — meaning an output can share one in five words with the input and still "pass." These aren't bugs. They're reasonable starting points. But leaving them as permanent configuration is like setting a smoke alarm that only triggers during a five-alarm fire.

## What "100% Pass Rate" Actually Means

A 100% pass rate doesn't mean your agents are perfect. It means your evals aren't discriminating.

There are two patterns that create this:

**Pattern 1: Rules that can't evaluate.** When an eval rule requires context that isn't provided — expected output for comparison, input context for relevance checking, cost data for budget enforcement — what should it do? The naive answer is "pass by default." The correct answer is "exclude itself from the score."

If a relevance rule can't measure relevance because no input was provided, counting it as a perfect 1.0 inflates the overall score. It's not a measurement — it's noise masquerading as signal.

**Pattern 2: Thresholds below the noise floor.** A topic consistency threshold of 5% means that if 1 in 20 output words matches the input, the output is "on topic." At that threshold, almost any response passes. The eval runs. The check is green. But the threshold is below the level where it can distinguish good output from mediocre output.

Both patterns produce the same symptom: a dashboard full of green that tells you nothing.

## The Fix: Exclude What You Can't Measure

The architectural fix is straightforward. Rules that lack the context they need should be marked as **skipped** and excluded from the weighted average — not scored as perfect.

```json
{
  "ruleName": "keyword_overlap",
  "passed": false,
  "score": 0,
  "skipped": true,
  "skipReason": "context.input not provided"
}
```

The eval engine then computes the [Output Quality Score](/blog/output-quality-score) only from rules that actually evaluated. If 3 of 13 rules ran and produced scores, OQS reflects those 3 — not a diluted average of 3 real scores and 10 phantom 1.0s.

When all rules are skipped, the result is honest:

```json
{
  "score": 0,
  "passed": false,
  "insufficient_data": true,
  "rules_evaluated": 0,
  "rules_skipped": 5,
  "suggestions": [
    "Insufficient context to evaluate. Provide: expected, input, costUsd, or tokenUsage."
  ]
}
```

This is better than a false 1.0. An `insufficient_data` result tells you exactly what's wrong and how to fix it. A fake pass tells you nothing.

## The Fix: Raise the Floor

Once phantom scores are excluded, the remaining rules need thresholds that actually discriminate. Here's what meaningful defaults look like:

| Rule | Before | After | Why |
|------|--------|-------|-----|
| Minimum output length | 10 chars | 50 chars | "Hello user" passed at 10. 50 requires a real sentence. |
| Sentence count | 1 | 2 | A fragment with a period passed at 1. |
| Keyword overlap | 20% | 35% | 20% = 1 in 5 words. Too loose for topic verification. |
| Topic consistency | 5% | 10% | 5% = 1 in 20 words. Below noise floor. |

These are still generous. Production teams will want to go higher. The point is that the defaults should sit above the noise floor — the level where the eval starts distinguishing quality differences rather than rubber-stamping everything.

## Making It Configurable

Defaults should be reasonable. But they shouldn't be permanent.

Every team's quality bar is different. An internal tool that summarizes emails has a different standard than a medical advice agent. A customer-facing chatbot needs different thresholds than a data extraction pipeline.

Configurable thresholds let teams dial in their own signal:

```json
{
  "eval": {
    "defaultThreshold": 0.7,
    "ruleThresholds": {
      "min_output_length": 100,
      "min_sentences": 3,
      "keyword_overlap": 0.50,
      "topic_consistency": 0.15,
      "cost_threshold": 0.05
    }
  }
}
```

This is the foundation for what [Self-Calibrating Eval](/blog/self-calibrating-eval) builds on — thresholds that aren't just configurable, but that evolve based on observed score distributions. First you make them adjustable. Then you make them self-adjusting.

## The Practical Impact

When you move from lenient defaults to calibrated thresholds, three things happen:

1. **Your pass rate drops.** This is correct. The evals are doing their job now. A pass rate that drops from 100% to 75% didn't get worse — it got honest.

2. **Your dashboard becomes useful.** [Eval Drift](/blog/eval-drift-the-silent-quality-killer) becomes visible. Quality trends appear. Per-rule breakdowns show which dimensions are strong and which need attention. The dashboard stops being a wall of green and starts being a diagnostic tool.

3. **Your team starts trusting the evals.** When the eval suite catches real issues — output too short, off-topic responses, cost overruns — the team learns to pay attention to failures instead of ignoring them.

This is how you close the eval gap. Not by building more rules, but by making the rules you have actually discriminate.

## Start Here

If you're running Iris, the v0.2.0 release ships these changes by default:

- Rules that lack context are excluded from scoring (not counted as 1.0)
- Thresholds are raised to meaningful defaults
- All thresholds are configurable via `~/.iris/config.json`
- The API response tells you exactly which rules evaluated, which were skipped, and why

If you're using another eval framework, audit your thresholds. Run your eval suite against known-bad output. If everything passes, your thresholds are below the noise floor.

The eval gap doesn't close by accident. It closes when your evals have teeth.

---

*This post builds on the [Eval Gap](/blog/the-eval-gap) vocabulary concept and the [Output Quality Score](/blog/output-quality-score) composite metric. For the reference definition, see [Eval Gap](/learn/eval-gap).*

*For the complete picture, see our [Agent Eval: The Definitive Guide](/learn/agent-eval).*
