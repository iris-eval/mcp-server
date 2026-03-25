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
```json
{
  "trace": {
    "spans": [
      { "tool": "database_query", "tokens": 1200, "duration_ms": 340 },
      { "tool": "database_query", "tokens": 3400, "duration_ms": 520 },
      { "tool": "analyze_data", "tokens": 8200, "duration_ms": 1200 },
      { "tool": "generate_report", "tokens": 4100, "duration_ms": 890 }
    ],
    "total_tokens": 16900,
    "total_cost_usd": 0.47
  }
}
```

### Evaluation Result
```json
{
  "score": 0.68,
  "rules": {
    "cost_under_threshold": { "pass": false, "detail": "$0.47 exceeds $0.25 threshold" },
    "response_complete": { "pass": true, "score": 0.95 },
    "topic_consistency": { "pass": true, "score": 1.0 }
  }
}
```

## Interpretation

The output quality is high (complete, relevant) but the cost rule fails — $0.47 is nearly 2x the budget threshold. This signals that the agent needs optimization:
- Can tool calls be batched?
- Is the retention model using too many tokens?
- Would a smaller model work for the data queries?

## Using get_traces for Trends

Call `get_traces` to see cost patterns over time:
```json
{
  "filter": { "metric": "cost_usd", "above": 0.25 },
  "limit": 10,
  "sort": "cost_desc"
}
```

This returns the most expensive recent runs, helping you identify which queries need optimization.
