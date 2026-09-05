# Example: Cost Tracking

## Scenario
An agent makes multiple tool calls to answer a complex query. You want to track the total cost and flag runs that exceed your budget threshold.

## Agent Execution
```
Query: "Analyze our top 10 customers and suggest retention strategies"

Tool calls:
1. database_query (customer list)
2. database_query (purchase history)
3. analyze_data (retention model)
4. generate_report (final output)

Token usage: 12,800 prompt + 4,100 completion = 16,900 total
Cost: $0.47
Budget threshold (Iris default): $0.10
```

The default `cost_under_threshold` budget is `$0.10` per evaluation. Change it with `eval.ruleThresholds.cost_threshold` in `~/.iris/config.json`, or deploy a `cost_threshold` custom rule with its own `max_cost` for a per-agent budget.

## Using Iris

Call `log_trace` first to record the execution, then `evaluate_output` to score it.

### Trace Logging

`log_trace` arguments (fields are top-level — there is no wrapper object):

```json
{
  "agent_name": "retention-analyst",
  "input": "Analyze our top 10 customers and suggest retention strategies",
  "output": "Top retention opportunities: the three enterprise accounts with declining monthly usage should get a dedicated success check-in this month; the four mid-market accounts approaching renewal should be offered the annual-plan discount; the remaining three are healthy and need no action.",
  "tool_calls": [
    { "tool_name": "database_query", "latency_ms": 340 },
    { "tool_name": "database_query", "latency_ms": 520 },
    { "tool_name": "analyze_data", "latency_ms": 1200 },
    { "tool_name": "generate_report", "latency_ms": 890 }
  ],
  "token_usage": { "prompt_tokens": 12800, "completion_tokens": 4100, "total_tokens": 16900 },
  "cost_usd": 0.47,
  "latency_ms": 2950
}
```

Actual response (captured 2026-09-03 against the shipped server):

```json
{ "trace_id": "becb5935791b352b551ffec747a2199a", "status": "stored" }
```

### Cost Evaluation

`evaluate_output` with `eval_type: "cost"` runs the built-in cost bundle (`cost_under_threshold`, `verbosity_ratio`). Pass `cost_usd` and `token_usage` — the cost bundle reads both, and `cost_usd` is also read by any `cost_threshold` custom rule whatever the `eval_type`:

```json
{
  "output": "Top retention opportunities: the three enterprise accounts with declining monthly usage should get a dedicated success check-in this month; the four mid-market accounts approaching renewal should be offered the annual-plan discount; the remaining three are healthy and need no action.",
  "eval_type": "cost",
  "cost_usd": 0.47,
  "token_usage": { "prompt_tokens": 12800, "completion_tokens": 4100, "total_tokens": 16900 },
  "trace_id": "becb5935791b352b551ffec747a2199a"
}
```

Actual response (captured 2026-09-03 against the shipped server):

```json
{
  "id": "77f5749a-11e4-4bf0-a3f5-341f9ec324f0",
  "eval_type": "cost",
  "score": 0.333,
  "passed": false,
  "rule_results": [
    { "ruleName": "cost_under_threshold", "passed": false, "score": 0, "message": "Cost ($0.4700) exceeds threshold ($0.1000)" },
    { "ruleName": "verbosity_ratio", "passed": true, "score": 1, "message": "Token ratio (0.32) is within limits (max 5)" }
  ],
  "suggestions": [
    "[cost_under_threshold] Cost ($0.4700) exceeds threshold ($0.1000)"
  ],
  "rules_evaluated": 2,
  "rules_skipped": 0,
  "insufficient_data": false
}
```

The top-level `passed` is the verdict; each rule reports its own `passed`, `score`, and a human-readable `message` with the actual and threshold amounts. Omit `cost_usd` and `cost_under_threshold` skips (`skipReason: "context.costUsd not provided"`) rather than passing — a skipped rule is excluded from the score.

## Interpretation

The output quality may be high, but the cost rule fails — $0.47 is almost five times the default budget. This signals that the agent needs optimization:
- Can tool calls be batched?
- Is the retention model using too many tokens?
- Would a smaller model work for the data queries?

## Using get_traces for Trends

Call `get_traces` to find the most expensive recent runs (`sort_by` + `sort_order` are enums; there is no `filter` or `sort` argument):

```json
{
  "sort_by": "cost_usd",
  "sort_order": "desc",
  "limit": 10,
  "include_summary": true
}
```

This returns the most expensive recent traces, helping you identify which queries need optimization. With `include_summary: true` the response also carries a `summary` block — `total_traces`, `avg_latency_ms`, `total_cost_usd`, `error_rate`, `eval_pass_rate`, `traces_per_hour`, `top_agents` — so you can read the aggregate spend in the same call.
