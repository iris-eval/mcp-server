---
title: "Eval-Driven Development: Write the Rules Before the Prompt"
description: "Eval-Driven Development applies TDD principles to AI agents: define eval rules before prompts, iterate on scores, ship when rules pass."
date: 2026-03-28
author: Ian Parent
tags: [edd, eval-driven-development, agent-eval, tdd, mcp, vocabulary]
relatedPosts: [eval-coverage-the-metric-your-agents-are-missing, the-eval-loop, the-eval-gap]
---

# Eval-Driven Development: Write the Rules Before the Prompt

Most teams building AI agents follow the same workflow: write a prompt, run it, look at the output, tweak, repeat. The definition of "good enough" is whatever the last reviewer felt was acceptable. It shifts based on who's reviewing, what time of day it is, and how close the deadline is.

There's a better way. It's the same discipline that transformed software development thirty years ago, applied to the unique properties of AI agents.

It's called **Eval-Driven Development (EDD)** — and the core principle is simple: define your evaluation rules before you write your prompt.

## The TDD Parallel

In 1994, Kent Beck formalized Test-Driven Development. The insight was counterintuitive: write the test before the code. Define what "correct" looks like before you start building. This forces you to specify the behavior, not just implement it.

The adoption curve took about 15 years:

- **1999:** Extreme Programming codified TDD as a core discipline
- **2003:** "TDD: By Example" became the codification artifact
- **2005-2010:** CI/CD systems made test gates structural
- **2010+:** Shipping without tests became professionally unacceptable

A joint [IBM and Microsoft study](https://www.microsoft.com/en-us/research/wp-content/uploads/2009/10/Realizing-Quality-Improvement-Through-Test-Driven-Development-Results-and-Experiences-of-Four-Industrial-Teams-nagappan_tdd.pdf) confirmed: TDD reduces post-release defects by 40-90%. Not because the tests themselves are magic — but because the discipline of defining "done" before you start forces clarity.

EDD is the same discipline, applied to agents. Without it, teams pay [the eval tax](/blog/the-ai-eval-tax) — the compounding cost of every unscored output.

## How EDD Works in Practice

The workflow inverts the typical "prompt and pray" approach:

**Step 1: Define your eval rules.**

Before writing a single line of prompt, define what "good output" means:

- Completeness: "Responses must address the user's specific question"
- Relevance: "Output must directly relate to the input context"
- Safety: "No PII (SSN, credit card, phone, email patterns). No prompt injection patterns."
- Cost: "Must complete in under $0.05 per call"

These rules are your specification. They define done.

**Step 2: Write your agent prompt.**

Now build. You have a clear target to build toward.

**Step 3: Run the eval. See the score.**

Run your agent through the eval rules. Get a score. See which rules pass and which fail.

**Step 4: Iterate on the prompt to improve the score.**

Each iteration has a signal — not "does this seem better?" but "did the score improve? Which rules are still failing?"

**Step 5: Lock the eval rules.**

When all rules pass consistently, the eval rules become your agent's specification. They run on every execution in production, catching regressions automatically. This is how you achieve 100% [eval coverage](/blog/eval-coverage-the-metric-your-agents-are-missing) — the metric that separates production-grade agents from demos.

## Why EDD Produces Better Agents

Writing eval rules first forces three things that dramatically improve output quality:

**1. You define "good" before you bias yourself.**

Once you've seen a prompt's outputs, you unconsciously calibrate your expectations to what the prompt produces. This is confirmation bias applied to AI. Pre-defining the eval rules removes that bias. You're measuring against a fixed standard, not a moving target.

**2. You separate specification from implementation.**

The eval rule is the spec. The prompt is the implementation. This is exactly the discipline TDD enforces in code. When spec and implementation are the same thing — "the prompt is whatever produces outputs I like" — there is no way to detect regression.

**3. Iteration has a quantitative signal.**

Without eval rules, prompt iteration is vibes. You change a few words and ask "does it seem better?" With eval rules, iteration is data: the score went from 0.72 to 0.88. The relevance rule went from failing to passing. The cost rule is still red — the prompt needs to be more concise.

## The Red/Green/Refactor Cycle for Agents

EDD creates a feedback loop that mirrors TDD:

- **Red:** Eval fails on the current prompt. Completeness score is 0.6, below the 0.8 threshold.
- **Green:** Iterate the prompt. Add specificity. Re-run eval. Score hits 0.88. Green.
- **Refactor:** Tighten the eval rules. Add a new rule for response format. Does the prompt still pass? If not, iterate again.

The cycle has a terminal condition. The eval rules define when you're done. Without them, there is no terminal condition — prompt iteration continues until someone ships whatever's in front of them.

## This Isn't Just an Idea

The concept has academic backing. A November 2024 paper ([arXiv 2411.13768](https://arxiv.org/abs/2411.13768)) formally proposed Eval-Driven Development as a process model, describing it as "inspired by test-driven and behavior-driven development but reimagined for the unique characteristics of LLM agents."

OpenAI's own cookbook documents "Eval Driven System Design" as a design pattern.

The practice exists. A few leading teams use it. The codification artifact doesn't yet exist. The tooling is becoming structural.

Sound familiar? That's exactly where TDD was in 1999.

## Getting Started with EDD

If you're building an agent today, here's the minimum viable EDD workflow:

1. **Before your next prompt change,** write down three rules that define "good output" for your use case
2. **Run the agent** and evaluate the output against those rules
3. **If it fails,** iterate the prompt with the specific failing rule as your target
4. **If it passes,** ship it — and keep those rules running on every execution in production

The rules don't have to be complex. "Output must not contain PII" is a rule. "Response must be under 500 tokens" is a rule. "Must include a source citation" is a rule. Start simple. Tighten over time.

## How Iris Enables EDD

Iris provides the evaluation framework that makes EDD operational. When you call `evaluate_output`, it scores against up to 13 built-in rules across four categories that map directly to the dimensions you need to define before writing a prompt:

- **Completeness:** What must the output contain?
- **Relevance:** What must it relate to?
- **Safety:** What must it never contain?
- **Cost:** What's the acceptable resource budget? (See [Heuristic vs Semantic Eval](/blog/heuristic-vs-semantic-eval) for how these rules run in sub-millisecond time.)

Custom eval rules extend these to your domain using a structured config format with 8 built-in rule types, or by implementing the EvalRule interface in TypeScript. The workflow: define your eval criteria → use Iris to score agent outputs → iterate using eval scores as the signal → lock rules when the agent ships.

That's EDD. Write the rules before the prompt. Measure against a standard, not a feeling. Ship when the rules say you're done, not when you run out of time.

*For the complete picture, see our [Agent Eval: The Definitive Guide](/learn/agent-eval).*

---

*Iris is the agent eval standard for MCP. Start with EDD today: [iris-eval.com/playground](https://iris-eval.com/playground)*
