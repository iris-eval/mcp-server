---
title: "The Cost of Invisible Agents: What $0.47 Per Query Looks Like at Scale"
published: false
description: "Last month I got a message from a developer running a research agent in production. His APM dashboard looked fine. HTTP 200s across the board. P99 latency ..."
tags: mcp, aiagents, observability, opensource
canonical_url: https://iris-eval.com/blog/the-cost-of-invisible-agents
---

Last month I got a message from a developer running a research agent in production. His APM dashboard looked fine. HTTP 200s across the board. P99 latency under 2 seconds. Error rate at 0.1%. By every traditional metric, the system was healthy.

Then finance flagged an anomaly. The LLM API bill for one internal tool had hit $14,000 in a single month. The agent was burning $0.47 per query. At roughly 1,000 queries per day, that added up to $470/day before anyone with engineering access noticed. The APM dashboard never flinched because, from its perspective, nothing was wrong. Every request succeeded. Every response came back.

This is the cost visibility gap in agent infrastructure, and it is wider than most teams realize.

## The Math That APM Cannot Do

To understand how $0.47 per query happens, you have to understand how agents consume tokens. It is not one LLM call per request. A research agent doing its job might follow this pattern:

1. **Initial reasoning** -- the model reads the user query, system prompt, and conversation history. That is 1,500 prompt tokens and 300 completion tokens.
2. **Tool selection and first call** -- the agent decides to search a knowledge base. Another 2,000 prompt tokens (original context plus tool descriptions) and 200 completion tokens.
3. **Process results, make second tool call** -- search results come back, the agent reads them, decides it needs more detail, and calls a different tool. 2,500 prompt tokens, 250 completion tokens.
4. **Third tool call** -- retrieves a specific document. 2,200 prompt tokens, 150 completion tokens.
5. **Synthesis** -- the agent reads all accumulated context and generates a final answer. 3,000 prompt tokens, 800 completion tokens.

That is 5 LLM inference steps with a total of 11,200 prompt tokens and 1,700 completion tokens. On GPT-4o, that costs roughly $0.04. Manageable. But swap the model to Claude 3.5 Sonnet at $3/$15 per million tokens, and the same trace costs about $0.06. Still fine.

Now here is where it breaks. Suppose the agent has a prompt engineering issue -- a system prompt that is too long, or a retrieval step that dumps entire documents into context instead of relevant chunks. The prompt tokens per step jump from 2,000 to 8,000. Five tool calls at 8,000 prompt tokens each, plus a synthesis step at 15,000 prompt tokens. Now you are at 55,000 prompt tokens per trace.

On GPT-4 Turbo ($10/$30 per million tokens): **$0.47 per query.**

On Claude 3 Opus ($15/$75 per million tokens): **$0.94 per query.**

The agent still returns correct answers. The HTTP status code is still 200. Latency might be slightly higher, but within acceptable bounds. There is no error to alert on. There is just a cost number that nobody is tracking at the trace level.

## Why Traditional Monitoring Cannot See This

APM tools were built for a world where compute cost is a function of infrastructure -- CPU hours, memory, network egress. You provision servers, you pay for servers, and your monitoring tells you whether those servers are healthy.

Agent costs do not work that way. The cost is embedded in the API call payload. It varies per request based on prompt length, model selection, number of inference steps, and completion length. Two requests to the same agent endpoint can cost $0.02 and $0.47 respectively, and your APM sees them as identical successful requests.

Here is what traditional monitoring tracks for an agent request:

- **HTTP status:** 200
- **Latency:** 1,847ms
- **Payload size:** 4.2KB response
- **Error rate:** 0%

Here is what it does not track:

- **Prompt tokens per step:** 8,000 (5x higher than expected)
- **Total tokens:** 55,000
- **Model used:** gpt-4-turbo (someone changed it from gpt-4o-mini last Tuesday)
- **Cost:** $0.47
- **Cost by agent:** research-bot is 12x more expensive than support-bot
- **Cost trend:** average cost per trace increased 340% over the last 72 hours

The second list is the one that tells you about the $14,000 bill before finance does.

## What Cost Visibility Actually Looks Like

When I built cost tracking into Iris, the goal was to make per-trace cost a first-class metric -- as visible and queryable as latency or error rate.

Every trace logged to Iris includes `cost_usd`:

```json
{
  "agent_name": "research-bot",
  "input": "Summarize the competitive landscape for AI developer tools",
  "output": "The AI developer tools market...",
  "tool_calls": [
    { "tool_name": "search_reports", "input": "AI dev tools market 2026", "output": "..." },
    { "tool_name": "search_reports", "input": "developer tool adoption rates", "output": "..." },
    { "tool_name": "get_document", "input": "report-2026-q1-ai-tools", "output": "..." },
    { "tool_name": "extract_data", "input": "...", "output": "..." },
    { "tool_name": "format_summary", "input": "...", "output": "..." }
  ],
  "latency_ms": 4200,
  "token_usage": {
    "prompt_tokens": 55000,
    "completion_tokens": 1700,
    "total_tokens": 56700
  },
  "cost_usd": 0.47
}
```

That trace is now queryable. You can filter by agent, by time window, by cost range. The dashboard shows aggregate cost across all agents over any period. You can answer "what did research-bot cost us this week?" in one query instead of reverse-engineering it from an API billing page that does not break down by agent.

## The Budget Threshold Pattern

Seeing cost data is useful. Enforcing cost limits automatically is better.

Iris has a built-in eval rule called `cost_under_threshold`. Set a budget per trace, and every trace that exceeds it gets flagged automatically. No human has to watch a dashboard.

Using the built-in cost eval:

```json
{
  "output": "The AI developer tools market...",
  "eval_type": "cost",
  "trace_id": "trc_research_4a8f",
  "cost_usd": 0.47
}
```

Response:

```json
{
  "score": 0.21,
  "passed": false,
  "rule_results": [
    {
      "ruleName": "cost_under_threshold",
      "passed": false,
      "score": 0.21,
      "message": "Cost ($0.4700) exceeds threshold ($0.1000)"
    }
  ]
}
```

The default threshold is $0.10. You can configure it per agent or per use case using custom rules:

```json
{
  "output": "The AI developer tools market...",
  "eval_type": "custom",
  "cost_usd": 0.47,
  "custom_rules": [
    {
      "name": "research_bot_budget",
      "type": "cost_threshold",
      "config": { "max_cost": 0.15 },
      "weight": 2
    }
  ]
}
```

This gives research-bot a $0.15 per-trace budget. Any trace that exceeds it fails the eval. The dashboard shows the failure. If you build alerting on top of Iris (webhook on failed evals), you get notified the moment an agent starts overspending -- not 30 days later when the invoice arrives.

## Scale Implications

Here is the arithmetic that keeps me up at night.

Say you have 10 agents in production. Each handles 100 traces per day. Average cost per trace is $0.07. That is:

**10 agents x 100 traces x $0.07 = $70/day = $2,100/month**

Manageable. Budgeted. Expected.

Now suppose 3 of those agents develop a cost bug. Maybe someone updated a system prompt and added 4,000 tokens of instructions. Maybe a retrieval tool started returning full documents instead of snippets. Maybe a model config got changed from gpt-4o-mini to gpt-4-turbo during debugging and never got reverted. The affected agents now cost 5x normal -- $0.35 per trace instead of $0.07.

**7 healthy agents: 700 traces/day x $0.07 = $49/day**
**3 broken agents: 300 traces/day x $0.35 = $105/day**
**Total: $154/day = $4,620/month**

That is 2.2x the expected spend. And if you do not catch it for a full quarter:

**$4,620/month x 3 months = $13,860 in excess cost**

Compared to $6,300 if all agents were healthy. You burned an extra $7,560 because three agents had invisible cost regressions that no monitoring system flagged.

With per-trace cost tracking and budget thresholds, you catch this on day one. The eval fails. The trace is flagged. You investigate, find the prompt bloat or the wrong model config, fix it, and move on. The cost of the bug is $105 instead of $7,560.

## Cost Is an Observability Problem

The pattern I keep seeing is teams treating LLM cost as a finance problem -- something you reconcile at the end of the month against an invoice. But cost is an engineering signal. A sudden spike in per-trace cost tells you something changed in your agent's behavior. A gradual upward drift in token usage might indicate context window bloat from conversation history that is not being pruned. A single agent consuming 60% of your total spend tells you where to optimize first.

These are the same kinds of signals that latency monitoring and error tracking provide for traditional services. Cost just needs the same treatment: per-request tracking, aggregation, thresholds, and alerts.

That is what I built Iris to do. Not just for cost -- cost is one dimension alongside quality, safety, and completeness. But cost is the dimension that hits your bank account, and it is the one most teams are flying blind on.

## Try It

Iris is open-source, MIT licensed. Add it to your MCP config, log traces with `cost_usd`, and see what your agents are actually costing you.

```bash
npx @iris-eval/mcp-server --dashboard
```

Set a `cost_under_threshold` eval on every trace. The agents that are within budget will pass quietly. The ones that are not will tell you before finance does.

Code and docs at [github.com/iris-eval/mcp-server](https://github.com/iris-eval/mcp-server).
