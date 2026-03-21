---
title: "The Eval Gap: Why Your AI Demo Works and Production Doesn't"
published: false
description: "Your demo was flawless. Then you shipped, and users hit hallucinations, PII leaks, and $40 API calls. Here's why — and how to close the gap."
tags: ai, testing, agenteval, programming
canonical_url: https://iris-eval.com/blog/the-eval-gap
---

The demo went perfectly. The agent summarized the document, called the right tools in the right order, and produced a clean, correct output. Leadership was impressed. The go-ahead was given. Then you shipped.

Within a week, users reported hallucinated data. A support ticket about leaked PII. An agent run that cost $40 in API calls for a task that should cost $0.12. But in the demo, everything worked.

This is **the eval gap** — the distance between "agent works in demo" and "agent works in production." It's the invisible failure surface that appears only when real users, real data, and real edge cases replace the controlled demo environment.

## Why the Gap Exists

Four mechanisms create the eval gap, and they compound:

**1. Input distribution narrowing in demos.** Demo inputs are hand-crafted to succeed. Production inputs include users who write in French when the agent expects English, reference orders in legacy systems the agent can't access, ask questions outside scope and receive confident wrong answers, or send context that exceeds token limits in ways the demo never tested.

**2. Compound failure at scale.** The math is unforgiving. Lusser's Law from 1950s reliability engineering: a system's overall reliability is the product of its component reliabilities. For a 10-step agent chain at 90% per-step accuracy: 0.90^10 = **35.9% overall success**. 64% of runs fail. That 20-step demo that looked perfect? It succeeds only 12% of the time at 90% per-step accuracy.

**3. Context contamination.** In a demo, the agent runs with clean, focused context. In production, it accumulates conversation history, competes with noisy multi-turn context, and encounters tool call sequences that were never tested.

**4. Cost and rate-limit reality.** Demos run once. Production runs thousands of times per day. An agent that burns $40 on a task that should cost $0.12 passes the demo just fine. It's economically inviable at scale.

## The Numbers

The gap is not subtle:

- **95% of enterprise generative AI pilots fail to deliver measurable business impact** — they may technically deploy, but they don't produce ROI ([MIT NANDA, 2025](https://fortune.com/2025/08/18/mit-report-95-percent-generative-ai-pilots-at-companies-failing-cfo/))
- [Gartner predicts](https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027) **over 40% of agentic AI projects will be canceled by end of 2027**
- In a [survey of 1,340 AI practitioners](https://www.langchain.com/state-of-agent-engineering), **32% cite quality as the top barrier** to production deployment
- Only **37% run evals on real production traffic** — the rest are evaluating in conditions that don't match production
- Salesforce research on CRM tasks found AI agents achieving [less than 55% success](https://arxiv.org/abs/2411.02305) even with function-calling abilities — a fraction of demo benchmarks

The gap is where AI products die. And the cost of living with it — what we call [the eval tax](https://iris-eval.com/blog/the-ai-eval-tax) — compounds with every unscored output.

## The Software Analogy — But Worse

In traditional software, "works on my machine" was such a ubiquitous problem that the entire industry built a solution: Docker. Containerization made your machine everyone's machine. Environment parity closed the gap.

The eval gap is the same problem, but harder. You can containerize runtime environments. You cannot containerize model behavior. The demo environment and production environment can share identical infrastructure and still produce completely different output quality, because the input distribution, context, and edge cases are different.

Docker solved environment drift. Nothing has solved output quality drift — until evaluation runs inline on every execution. The discipline that closes this gap is [Eval-Driven Development](https://iris-eval.com/blog/eval-driven-development): define your eval rules before you write the prompt, and let the rules tell you when you are done.

## How to Close the Gap

The teams that successfully cross the eval gap share one practice: they run evals that reflect production conditions, not demo conditions.

This means:

1. **Eval on real inputs, not synthetic benchmarks.** Your test suite of 50 hand-crafted examples is not production. Production is the thousand weird, edge-case, multi-language, context-heavy inputs your users actually send.

2. **Eval on every execution, not a sample.** The eval gap hides in the long tail. The 5% of inputs that fail are the ones that generate support tickets, churn users, and surface in due diligence.

3. **Eval the outputs, not the infrastructure.** Your APM showing HTTP 200 means the request completed. It does not mean the answer was correct, safe, or cost-efficient — a distinction we explore in depth in [Agent Errors vs Application Errors](https://iris-eval.com/blog/agent-errors-vs-application-errors).

4. **Eval at the protocol layer.** If evaluation requires per-call instrumentation in your code, coverage will be incomplete. If evaluation is built into the protocol your agent already speaks, coverage is automatic.

## Where Iris Fits

The Iris playground shows you what agent eval looks like in practice — real scenarios, real eval rules, real scoring logic — so you can understand the gap before you experience it in production.

But the real value is inline evaluation in production. Iris integrates at the MCP protocol layer — agents call Iris eval tools the same way they call any other MCP tool, scoring outputs within the agent's own workflow. No separate infrastructure, no batch processing, no "we'll review next week."

The eval gap closes when you measure real performance, not demo performance. That's what inline evaluation enables.

---

*Iris is the agent eval standard for MCP. Try it in 60 seconds: [iris-eval.com/playground](https://iris-eval.com/playground)*
