# Example: Cost Tracking

## Scenario
An agent makes multiple tool calls to answer a complex query. You want to track the total cost and flag runs that exceed your budget threshold.

## Agent Execution
```
Query: "Analyze our top 10 customers and suggest retention strategies"

Tool calls:
1. database_query (customer list) — 1,200 tokens
2. database_query (purchase history) — 3,400 tokens
3. analyze_data (retention model) — 8,200 tokens
4. generate_report (final output) — 4,100 tokens

Total tokens: 16,900
Estimated cost: $0.47
Budget threshold: $0.25
```

## Using Iris

Call `log_trace` first to record the execution, then `evaluate_output` to score it.

### Trace Logging

`log_trace` arguments (fields are top-level — there is no wrapper object):

```json
{
  "agent_name": "retention-analyst",
  "input": "Analyze our top 10 customers and suggest retention strategies",
  "output": "Top retention opportunities: ...",
  "tool_calls": [
    { "tool_name": "database_query", "latency_ms": 340 },
    { "tool_name": "database_query", "latency_ms": 520 },
    { "tool_name": "analyze_data", "latency_ms": 1200 },
    { "tool_name": "generate_report", "latency_ms": 890 }
  ],
  "token_usage": { "total_tokens": 16900 },
  "cost_usd": 0.47,
  "latency_ms": 2950
}
```

### Cost Evaluation

`evaluate_output` with `eval_type: "cost"` runs the built-in cost bundle (`cost_under_threshold`, `token_efficiency`). Pass `cost_usd` — it is only consulted for cost evals:

```json
{
  "output": "Top retention opportunities: ...",
  "eval_type": "cost",
  "cost_usd": 0.47,
  "trace_id": "<id returned by log_trace>"
}
```

The response's `rule_results` array reports each rule by name with `passed`, `score`, and a human-readable `message`; the top-level `passed` is the verdict. A $0.47 run against the default budget fails `cost_under_threshold` with the overage in the message.

## Interpretation

The output quality may be high, but the cost rule fails — $0.47 is nearly 2x the budget threshold. This signals that the agent needs optimization:
- Can tool calls be batched?
- Is the retention model using too many tokens?
- Would a smaller model work for the data queries?

## Using get_traces for Trends

Call `get_traces` to find the most expensive recent runs (`sort_by` + `sort_order` are enums; there is no `filter` or `sort` argument):

```json
{
  "sort_by": "cost_usd",
  "sort_order": "desc",
  "limit": 10
}
```

This returns the most expensive recent traces, helping you identify which queries need optimization. To aggregate instead, add `include_summary: true` — the summary block carries `total_cost_usd` alongside latency and pass-rate rollups.
