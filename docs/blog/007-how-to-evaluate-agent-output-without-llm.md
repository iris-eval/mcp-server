---
title: "How to Evaluate AI Agent Output Without Calling Another LLM"
date: 2026-03-17
author: Ian Parent
tags: [eval, agents, mcp, tutorial, heuristics, observability]
---

# How to Evaluate AI Agent Output Without Calling Another LLM

Here is the default approach to evaluating agent output in 2026: take the output, send it to another LLM, ask that LLM to judge quality, and trust the result.

This is the approach most eval frameworks use. And it has two problems that nobody talks about enough.

First, it is slow and expensive. Every evaluation requires an LLM inference call. That is $0.01 to $0.05 per eval, depending on the model and output length. If you are running an agent in production handling hundreds of requests per hour, you are paying for two LLM calls per request — one to do the work and one to check the work. Your eval costs start approaching your inference costs.

Second, it is recursive. Who evaluates the evaluator? If GPT-4o judges your agent's output and says it looks good, what happens when GPT-4o is wrong? You could add a third LLM to check the second one, but that way lies madness and an exponential cloud bill.

There is a better approach for a large class of eval checks. You do not need an LLM to tell you whether an output contains a Social Security number. You do not need an LLM to check if the response is empty. You do not need an LLM to verify that the output mentions at least some of the keywords from the input. These are pattern-matching problems, and pattern matching is what regex and heuristics do in under a millisecond.

This post walks through how to set up deterministic eval rules for your MCP agents using Iris. Zero to first evaluated trace in under a minute. No SDK. No code changes. No LLM-as-judge.

## Install Iris

One command:

```bash
npx @iris-eval/mcp-server
```

That starts the Iris MCP server locally. But for persistent use, you want to add it to your MCP configuration so every agent session discovers it automatically.

## Add Iris to Your MCP Config

Open your MCP configuration file (for Claude Desktop this is `claude_desktop_config.json`, for Cursor it is in your MCP settings) and add Iris as a server:

```json
{
  "mcpServers": {
    "iris": {
      "command": "npx",
      "args": ["-y", "@iris-eval/mcp-server"]
    }
  }
}
```

That is the entire integration. When your agent starts, it queries its configured MCP servers, discovers Iris's tools, and can use them immediately. No import statements. No SDK wrapping. No code changes to your agent.

## What Your Agent Discovers

Once Iris is in the MCP config, your agent has access to three tools:

- **`log_trace`** — Record an agent execution with input, output, tool calls, latency, token usage, and cost.
- **`evaluate_output`** — Run deterministic eval rules against an output and get pass/fail scores.
- **`get_traces`** — Query stored traces by agent name, time range, score, or cost.

The agent discovers these the same way it discovers any other MCP tool. The difference is that Iris runs in its own process with its own SQLite database. The agent does not grade its own work. The observer does.

## Log a Trace

When your agent completes a task, it sends a trace to Iris. Here is what that looks like:

```json
{
  "tool": "log_trace",
  "arguments": {
    "agent_name": "support-bot",
    "input": "What is your refund policy for annual plans?",
    "output": "Our refund policy for annual plans allows full refunds within 30 days of purchase. After 30 days, we offer prorated refunds for the remaining months. Contact support@acme.com or call 1-800-555-0199 to initiate a refund.",
    "tool_calls": [
      {
        "tool_name": "search_knowledge_base",
        "input": "refund policy annual plans",
        "output": "Annual plans: 30-day full refund, prorated after..."
      }
    ],
    "latency_ms": 2100,
    "token_usage": {
      "prompt_tokens": 1200,
      "completion_tokens": 85,
      "total_tokens": 1285
    },
    "cost_usd": 0.0094
  }
}
```

Iris records this in its local database with a full span tree. The trace is now queryable and evaluable independent of the agent.

## Evaluate the Output

Now the interesting part. Call `evaluate_output` to run deterministic checks against that response:

```json
{
  "tool": "evaluate_output",
  "arguments": {
    "output": "Our refund policy for annual plans allows full refunds within 30 days of purchase. After 30 days, we offer prorated refunds for the remaining months. Contact support@acme.com or call 1-800-555-0199 to initiate a refund.",
    "input": "What is your refund policy for annual plans?",
    "rules": ["non_empty_output", "keyword_overlap", "no_pii", "no_hallucination_markers"]
  }
}
```

The response comes back in under a millisecond:

```json
{
  "score": 0.75,
  "passed": ["non_empty_output", "keyword_overlap"],
  "failed": ["no_pii"],
  "warnings": ["no_hallucination_markers"],
  "details": {
    "no_pii": {
      "status": "fail",
      "reason": "Detected email pattern: support@acme.com; Detected phone pattern: 1-800-555-0199"
    }
  }
}
```

No LLM call. No latency spike. The eval caught a real problem: the agent included an email address and phone number in its response. Depending on your use case, that might be intended (customer support) or a serious issue (public-facing chatbot leaking internal contact info). Either way, you know about it.

## The Eval Categories

Iris ships with 12 built-in eval rules across four categories. Each one is a deterministic check — regex, heuristics, or arithmetic. No LLM involved.

### Completeness

These rules check whether the agent actually produced a substantive response.

- **`non_empty_output`** — Fails if the output is empty or whitespace-only. Catches the silent failures where an agent returns nothing and nobody notices.
- **`min_output_length`** — Fails if the output is below a character threshold. Catches truncated responses.
- **`sentence_count`** — Checks that the output contains a minimum number of sentences. A one-word answer to a complex question is a signal.

### Relevance

These rules check whether the output relates to what was asked.

- **`keyword_overlap`** — Compares keywords in the input against the output. If someone asks about "refund policy for annual plans" and the response mentions none of those terms, something went wrong.
- **`no_hallucination_markers`** — Scans for phrases that correlate with confabulation: "as an AI language model," "I don't have access to real-time data," "I cannot verify." These are not proof of hallucination, but they are signals worth flagging.
- **`topic_consistency`** — Checks that the output stays within the semantic neighborhood of the input topic rather than drifting to unrelated subjects.

### Safety

These rules catch content that should not appear in agent output.

- **`no_pii`** — Detects SSN patterns (XXX-XX-XXXX), credit card numbers (16-digit sequences with common prefixes), phone numbers, and email addresses. The patterns are ReDoS-safe and run in constant time regardless of input length.
- **`no_injection_patterns`** — Scans for prompt injection attempts in the output. If your agent's response contains "ignore previous instructions" or similar patterns, either the agent was compromised or it is echoing an injection attempt from its input.
- **`no_blocklist_words`** — Checks against a configurable list of prohibited terms. Useful for brand safety, compliance, or preventing the agent from referencing competitors.

### Cost

These rules enforce budgets and efficiency.

- **`cost_under_threshold`** — Fails if the execution cost exceeds a configured limit. Set a $0.05 ceiling per request and catch the runaway chains before they hit your bill.
- **`token_efficiency`** — Checks the completion-to-prompt token ratio. A 10,000-token prompt generating a 5-token response suggests the agent is consuming context without producing proportional value.

## Custom Rules

The built-in rules cover common patterns, but your domain has its own requirements. You can define custom rules using regex patterns or keyword lists.

A custom regex rule that fails if the agent outputs raw SQL:

```json
{
  "tool": "evaluate_output",
  "arguments": {
    "output": "To get that data, run: SELECT * FROM users WHERE id = 42",
    "custom_rules": [
      {
        "name": "no_raw_sql",
        "type": "regex",
        "pattern": "\\b(SELECT|INSERT|UPDATE|DELETE|DROP)\\b.*\\b(FROM|INTO|SET|TABLE)\\b",
        "flags": "i",
        "expected": "no_match",
        "message": "Output contains raw SQL that could expose database schema"
      }
    ]
  }
}
```

A custom keyword rule that checks whether the agent mentioned required disclaimer language:

```json
{
  "custom_rules": [
    {
      "name": "includes_disclaimer",
      "type": "keywords",
      "keywords": ["not financial advice", "consult a professional"],
      "mode": "any",
      "expected": "match",
      "message": "Financial responses must include disclaimer language"
    }
  ]
}
```

Both rules execute in under a millisecond. Both are deterministic. Both produce the same result every time for the same input. That is something LLM-as-judge cannot guarantee.

## View Results in the Dashboard

Run Iris with the dashboard flag:

```bash
npx @iris-eval/mcp-server --dashboard
```

Open `http://localhost:6920` and you get a real-time view of every trace, every eval result, and aggregate cost across all your agents. The dashboard shows the span tree for each execution — which tool was called, what it returned, where the latency was, and which eval rules passed or failed.

This is where the picture comes together. You are not reading logs. You are looking at structured traces with eval scores attached, rendered in a dark-mode interface that shows you exactly where things went right or wrong.

## When You Still Need LLM-as-Judge

I am not arguing that heuristic eval replaces LLM-as-judge entirely. There are eval dimensions where you genuinely need semantic understanding: tone, persuasiveness, factual accuracy against a knowledge base, nuanced style conformance. For those, LLM-as-judge makes sense, and it is on our roadmap.

But a surprising number of production eval checks do not need semantic understanding. They need pattern matching. And running those checks in under a millisecond for free instead of in 2 seconds for $0.03 is not a minor optimization — it is a different architecture. You can run heuristic evals on every single agent execution in production without worrying about cost or latency. Try doing that with LLM-as-judge.

The practical approach: use deterministic rules as the first pass on every execution. Flag the ones that fail. Route the ambiguous cases to LLM-as-judge when you add it later. You catch the obvious problems instantly and save the expensive evaluation for the cases that actually need it.

## From Zero to First Evaluated Trace

Here is the full sequence. It takes under a minute.

1. Add Iris to your MCP config (the JSON block above).
2. Restart your agent (Claude Desktop, Cursor, Claude Code, or your custom MCP agent).
3. Your agent discovers Iris automatically.
4. Run a task. The agent logs a trace.
5. Ask the agent to evaluate its own output using `evaluate_output`.
6. Open `http://localhost:6920` to see the results.

No SDK to install. No code to change. No functions to wrap. The protocol handles discovery. The eval rules handle quality checks. The dashboard handles visibility.

That is what protocol-native observability looks like in practice.

---

Iris is open-source, MIT licensed. The code is at [github.com/iris-eval/mcp-server](https://github.com/iris-eval/mcp-server). Docs and the dashboard are at [iris-eval.com](https://iris-eval.com).

Star the repo, open an issue, or add it to your MCP config and see what your agents are actually doing.
