---
title: "The Eval Loop: Why Evals Are the Loss Function for Agent Quality"
description: "Most teams treat eval as a one-time gate. The real pattern is a continuous loop: score, diagnose, calibrate, re-score. This is the eval loop — and it changes how you build agents."
date: 2026-03-30
author: Ian Parent
tags: [eval-loop, agent-eval, quality, calibration, mcp, vocabulary]
devto_tags: [ai, testing, agenteval, programming]
---

# The Eval Loop: Why Evals Are the Loss Function for Agent Quality

If you've trained a model, you know the loss function. You feed data in, measure how wrong the output is, adjust the weights, and measure again. The model never "passes" the loss function and graduates. The loss function runs on every batch, forever, because the goal is not to pass — it's to converge.

Most teams building AI agents have not internalized this. They treat evaluation as a gate: run the evals, get a passing score, ship. The eval is a tollbooth on the road to production. You pay once and drive through.

That mental model is broken. And it's costing the industry in ways that don't show up until production quality collapses and nobody can explain why.

## The One-Shot Eval Problem

Here's the pattern I see repeatedly: a team builds an agent, writes some eval criteria (or more commonly, eyeballs the output a few times), confirms it works, and ships. The eval was a moment. It happened on a Tuesday. The team moved on.

Six weeks later, quality is degrading. Users are complaining. But nothing changed in the codebase. The prompts are identical. The infrastructure is green.

What changed is everything outside the codebase. The model provider updated weights silently. The input distribution shifted as real users replaced test data. The edge cases multiplied. This is [eval drift](/blog/eval-drift-the-silent-quality-killer) — and it's invisible to teams that treated eval as a one-time event.

A [Stanford/Berkeley study](https://arxiv.org/abs/2307.09009) (Chen et al., 2023) measured this directly: GPT-4's rate of directly executable code generations dropped from 52% to 10% between March and June 2023, with no changelog and no API version bump. Teams that "passed eval" in March were shipping degraded outputs in June without knowing it.

One-shot eval creates a false sense of security. The score you got on Tuesday is not the score you have on Friday.

## The Eval Loop

The alternative is not "more evals" — it's a fundamentally different relationship with evaluation. I call it **the eval loop**:

**Score -> Diagnose -> Calibrate -> Re-score**

This is the pattern:

1. **Score.** Run eval rules on every agent output. Not sampling. Not spot-checks. Every execution gets a quality score, a safety check, and a cost assessment.

2. **Diagnose.** When scores degrade, identify which specific rules are failing. Is it completeness dropping? Relevance declining? PII slipping through? Cost thresholds breaching? The diagnosis needs to be granular — "quality went down" is not actionable.

3. **Calibrate.** Adjust the eval rules and thresholds based on what you learned. Maybe your relevance threshold was too lenient and let marginal outputs through. Maybe a new failure pattern emerged that no existing rule catches. You write a new rule. You tighten a threshold. You recalibrate the system to match the reality of your production environment.

4. **Re-score.** Run the calibrated rules against your agent outputs and measure again. Did the calibration improve detection? Are you catching the failures you missed before?

Then repeat. Continuously.

This is not a workflow you do at launch. It is the workflow. The eval loop runs for the lifetime of the agent, the same way a loss function runs for the lifetime of training.

## Why the Analogy to Loss Functions Is Precise

In model training, the loss function serves three purposes: it quantifies how wrong the model is, it provides a signal for improvement, and it runs continuously. Nobody would train a model by computing the loss once, declaring it acceptable, and never measuring again.

Evals serve the same three purposes for agent quality:

- **Quantify the gap.** An [output quality score](/blog/eval-coverage-the-metric-your-agents-are-missing) tells you exactly how far your agent's output is from your quality bar — across completeness, relevance, safety, and cost.
- **Provide a signal.** Granular rule-level results tell you *what* to fix. A completeness rule failing on 30% of outputs points directly at the problem. This is the diagnostic signal that "users are complaining" does not give you.
- **Run continuously.** The score is only meaningful if it's current. A score from last month is as useful as a loss value from epoch 1 — it tells you where you were, not where you are.

The critical difference: in model training, you adjust the model's weights. In agent eval, the agent doesn't need to be retrained. **You adjust the eval rules and thresholds.** The calibration happens in the evaluation layer, not the model layer. This is what makes the eval loop practical — you're tuning a deterministic system, not retraining a neural network.

## Why Deterministic Rules Make the Loop Auditable

This is where the choice of eval approach matters. If your eval is an LLM judging another LLM's output, your calibration step is opaque. You adjust a prompt and hope the LLM judge changes behavior. You can't inspect the decision boundary. You can't diff the change. You can't explain to an auditor why the eval system's behavior shifted.

Deterministic eval rules — pattern matching, threshold checks, structural validation — make every step of the loop inspectable:

- You can see exactly which rule failed and why.
- You can diff the calibration: "We changed the cost threshold from $0.50 to $0.25 on March 15th because production data showed runaway calls clustering at $0.30."
- You can audit the entire history of calibrations.
- You can reproduce any eval result from any point in time.

Iris runs 12 deterministic eval rules across four categories — completeness, relevance, safety, and cost. Every rule result is persisted with a timestamp. When you calibrate a threshold, the before-and-after is fully traceable. This is [eval-driven development](/blog/eval-driven-development) in practice: the rules are the specification, and calibrating them is how the specification evolves with production reality.

## The Self-Calibrating Eval — Where This Goes Next

The eval loop as described above is human-driven. You look at the scores, you diagnose the problem, you calibrate the rules. This works. But it requires someone to be watching.

The next evolution — and this is the pattern I think the industry needs to build toward — is **the self-calibrating eval**: systems that detect their own miscalibration and propose corrections.

The signal is already there. If a rule's pass rate drops 15 percentage points in a week with no code change, that's either eval drift (the model changed) or threshold miscalibration (the rule doesn't match current production patterns). A self-calibrating system would detect this divergence, surface the affected rules, and propose threshold adjustments for human review.

This isn't autonomous rule rewriting — that would undermine the auditability that makes deterministic eval valuable. It's automated detection of when your eval system is out of sync with reality, paired with suggested recalibrations that a human approves. The human stays in the loop. The system just makes the loop faster.

## Agents That Loop Will Outperform Agents That Passed

Here's the bottom line.

Two teams ship agents into production. Team A ran evals once, passed, and moved on. Team B runs evals on every execution and calibrates weekly based on the scores.

After three months, Team A's agent has silently degraded through eval drift. They don't know their quality score. They find out about failures from support tickets. Every fix is reactive — a fire drill triggered by a user complaint.

Team B's agent has been continuously scored. When quality dipped in week 4, they tightened the relevance threshold. When a new failure pattern appeared in week 8, they added a rule. Their agent is measurably better in month 3 than it was at launch, not because the model improved, but because the eval loop caught problems early and calibration addressed them.

The [LangChain State of Agent Engineering survey](https://www.langchain.com/state-of-agent-engineering) (1,340 respondents, late 2025) found that only 37% of teams run online evals on production traffic. That means 63% of teams are flying without a continuous quality signal. They shipped an agent that passed a test once. They have no loop.

The teams that build the eval loop into their agent infrastructure will compound quality improvements over time. The teams that don't will compound [the eval tax](/blog/the-ai-eval-tax) — the silent cost of every unscored output.

## The Pattern

The eval loop is not a feature of any particular tool. It's a discipline — the same way continuous integration is a discipline, not a Jenkins feature.

But the discipline requires infrastructure. You need eval rules that run on every execution. You need scores persisted over time so you can see trends. You need rule-level granularity so you can diagnose failures. And you need the ability to calibrate thresholds without redeploying your agent.

Iris provides this infrastructure at the MCP protocol layer. Agents call Iris eval tools the same way they call any other MCP tool — no SDK, no code changes. Add it to your MCP config. Scores are persisted. Trends are visible. Calibration is a configuration change.

But the insight is bigger than any single tool: **evals are not a gate. They are a feedback signal. The eval loop is what makes that signal useful.**

Stop treating evaluation as a tollbooth. Start treating it as a loss function. Score, diagnose, calibrate, re-score. Repeat.

*For the complete picture, see our [Agent Eval: The Definitive Guide](/learn/agent-eval).*

---

*The eval loop starts with scoring every output. Try it: [iris-eval.com/playground](https://iris-eval.com/playground)*
