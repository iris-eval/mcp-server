---
title: "The AI Eval Tax: The Hidden Cost Every Agent Team Is Paying"
date: 2026-03-21
author: Iris Team
tags: [eval-tax, agent-eval, production, cost, mcp, vocabulary]
---

# The AI Eval Tax: The Hidden Cost Every Agent Team Is Paying

You're paying a tax you don't know about.

Every time your AI agent returns something wrong and nobody catches it — a hallucinated fact, a leaked email address, a $40 API call for a task that should cost $0.12 — you're paying. Not in dollars on an invoice. In customer trust, in engineering hours, in liability exposure that compounds silently until an incident makes it visible.

This is the **eval tax**: the compounding cost of every agent output you didn't evaluate.

## You Think Eval Is Overhead. It's Actually the Only Way to Make Agents Affordable.

The industry has a strange relationship with agent evaluation. Teams will spend months optimizing a prompt, instrument every function with APM, set up alerting on latency and error rates — and then ship the agent into production with no systematic check on whether the outputs are actually correct, safe, or cost-efficient.

The numbers show what this costs:

- An estimated **$67.4 billion** in global financial losses tied to AI hallucinations in 2024 alone ([AllAboutAI](https://allaboutai.com/resources/ai-statistics/ai-hallucinations/))
- Industry estimates put hallucination-related verification costs at **$14,200 per employee per year** — knowledge workers spending hours every week fact-checking AI outputs instead of doing their jobs
- A hallucinated answer in Google's Bard demo erased **$100 billion in Alphabet's market cap** in a single day ([Time, Feb 2023](https://time.com/6254226/alphabet-google-bard-100-billion-ai-error/))
- AI safety incidents surged **56.4% year-over-year** — from 149 to 233 documented incidents ([Stanford AI Index 2025](https://hai.stanford.edu/ai-index/2025-ai-index-report))

These are not theoretical risks. They're the invoices.

## The Air Canada Precedent

In 2024, Jake Moffatt sued Air Canada after its chatbot hallucinated a bereavement fare refund policy that didn't exist. The chatbot was confident. The answer was detailed. It was completely fabricated.

The BC Civil Resolution Tribunal's ruling: **Air Canada is liable for negligent misrepresentation by its chatbot.** The company was forced to honor a discount the chatbot invented ([McCarthy Tétrault analysis](https://www.mccarthy.ca/en/insights/blogs/techlex/moffatt-v-air-canada-misrepresentation-ai-chatbot)).

Every AI agent team now operates under this precedent. Every unscored output is a potential *Moffatt v. Air Canada*. Every hallucination that reaches a customer is a liability event waiting for a plaintiff.

## Where the Tax Compounds

The eval tax doesn't hit all at once. It compounds across four dimensions, silently, until the bill comes due:

**1. Token waste.** Agents without quality gates re-run on failures, get stuck in loops, and consume far more tokens than expected. Tool-calling agents commonly use 5-20x more tokens than simple chains due to retries and looping ([Galileo AI](https://galileo.ai/blog/hidden-cost-of-agentic-ai)). Without cost eval gates, there's no mechanism to stop a runaway call.

**2. Engineering time.** A large majority of enterprises maintain human-in-the-loop processes specifically to catch hallucinations before they reach users. That's not automation — that's manual QA at scale, paid at engineering salaries. Teams can't ship faster because every release requires human review of agent outputs that should be scored automatically.

**3. Liability exposure.** Every undetected PII leak is a potential EU AI Act violation (up to €35 million or 7% of global revenue). Every fabricated citation is a potential *Mata v. Avianca* — the case where an attorney was sanctioned for submitting AI-hallucinated case law. Every wrong answer to a customer is a potential Air Canada.

**4. Trust erosion.** The [Stack Overflow 2025 Developer Survey](https://survey.stackoverflow.co/2025/ai) found that more developers actively **distrust** AI accuracy (46%) than trust it (33%). The #1 frustration, cited by 66% of developers: "AI solutions that are almost right, but not quite." Trust is at an all-time low. Your users feel it even when your dashboards don't show it.

One bad output is a bug. No eval system is a tax.

## The Compounding Mechanism

Here's how the eval tax turns invisible costs into visible crises:

Agent hallucinates → customer gets wrong answer → support escalation → engineering investigates (no trace data, can't reproduce) → customer churns → team adds manual review → review costs more than the tokens they saved → velocity collapses because every release requires human QA → competitors with eval infrastructure ship 3x faster.

And it gets worse with scale. A 3% hallucination rate sounds manageable. But in a 10-step agent chain, Lusser's Law applies: 0.97^10 = 74% overall success rate. **26% of runs have at least one failure.** Nobody tracks this systematically. The failures hide in the long tail where your support team finds them weeks later.

## The Historical Parallel

We've been here before.

In 2003, "we'll test manually" was a perfectly normal thing to say about software quality. JUnit had existed since 1997. The tools were available. The culture hadn't caught up. Most teams shipped without automated tests and it was considered acceptable.

Then Facebook made "move fast and break things" its motto. By 2014, they'd abandoned it for "move fast with stable infrastructure" — the moment the industry acknowledged that velocity without reliability is not a strategy.

The adoption curve for testing culture took about 15 years:

- 1997: JUnit released. Tools exist.
- 2003: Most teams ship without tests. Normal.
- 2005-2010: CI/CD makes test gates structural, not optional.
- 2010+: Shipping without tests becomes a professional red flag.

A joint IBM and Microsoft study confirmed: TDD reduces post-release defects by [40-90% depending on team](https://www.microsoft.com/en-us/research/wp-content/uploads/2009/10/Realizing-Quality-Improvement-Through-Test-Driven-Development-Results-and-Experiences-of-Four-Industrial-Teams-nagappan_tdd.pdf).

Where are we with agent eval? The [LangChain State of Agent Engineering survey](https://www.langchain.com/state-of-agent-engineering) (1,340 respondents, late 2025) tells us exactly: **89% of teams have observability** (is the agent running?), but **only 37% have inline eval** (is the answer right?). That 52-point gap is the eval tax manifesting as a metric. Most teams can tell you whether their agent returned a response. They cannot tell you whether the response was any good.

We're in 2003. The tools exist. The culture hasn't caught up.

## What the Tax Looks Like When It's Paid

The eval tax is paid either way. The question is whether you pay it on your schedule or the production incident's schedule.

**Paying later (the default):** Thousands per employee in verification costs. Hours every week in manual fact-checking. Human-in-the-loop at engineering salaries. Incident response when the hallucination reaches a customer. Legal fees when the customer calls a lawyer.

**Paying now (the alternative):** Score every output across three dimensions — quality, safety, cost — inline, on every execution. Catch the hallucination before the customer sees it. Catch the PII leak before it leaves the system. Catch the $40 API call before it hits the invoice.

[Gartner predicts](https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027) over 40% of agentic AI projects will be canceled by 2027 — citing escalating costs, unclear business value, and inadequate risk controls. The teams that survive are the ones that built eval infrastructure early, when the cultural window was still open.

## The Window

Right now, most teams are choosing their eval posture. The habit is forming. The infrastructure decisions being made today — inline eval or manual review, protocol-native or bolted-on, every execution or spot-check — will determine which teams ship reliable agents at scale and which teams drown in the compounding interest of unscored outputs.

Iris exists because this problem is structural, not optional. It integrates at the MCP protocol layer — agents call Iris eval tools the same way they call any other MCP tool, scoring outputs for quality, safety, and cost inline within the agent's workflow. Add it to your MCP config. No code changes. No SDK dependency.

But the insight is bigger than any single tool: **agents without evaluation are demos, not products.** The eval tax is the cost of treating production agents like demos. And the bill always comes due.

---

*You're already paying the eval tax. You just don't know how much.*

*Start evaluating: [iris-eval.com/playground](https://iris-eval.com/playground)*
