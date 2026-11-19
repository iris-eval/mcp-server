# Example: Cost Tracking

## Scenario
An agent makes several tool calls to answer a complex query. You want to track what each run costs and stop the runs that go over your budget.

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
```

## Using Iris

Call `log_trace` to record the run, then `evaluate_output` with its `trace_id` to score it.

### Trace Logging

`log_trace` arguments (fields are top-level — there is no wrapper object):

<!-- iris:cost-log-request:start -->
```json
{
  "agent_name": "retention-analyst",
  "input": "Analyze our top 10 customers and suggest retention strategies",
  "output": "Top retention opportunities: the three enterprise accounts with declining monthly usage should get a dedicated success check-in this month; the four mid-market accounts approaching renewal should be offered the annual-plan discount; the remaining three are healthy and need no action.",
  "tool_calls": [
    {
      "tool_name": "database_query",
      "input": {
        "table": "customers",
        "order_by": "revenue",
        "limit": 10
      },
      "latency_ms": 340
    },
    {
      "tool_name": "database_query",
      "input": {
        "table": "purchases",
        "customer_ids": "top-10"
      },
      "latency_ms": 520
    },
    {
      "tool_name": "analyze_data",
      "input": {
        "model": "retention"
      },
      "latency_ms": 1200
    },
    {
      "tool_name": "generate_report",
      "input": {
        "format": "summary"
      },
      "latency_ms": 890
    }
  ],
  "token_usage": {
    "prompt_tokens": 12800,
    "completion_tokens": 4100,
    "total_tokens": 16900
  },
  "cost_usd": 0.47,
  "latency_ms": 2950
}
```
<!-- iris:cost-log-request:end -->

The response. A `trace_id` is minted on every call, so yours will differ:

<!-- iris:cost-log-response:start -->
```json
{
  "trace_id": "becb5935791b352b551ffec747a2199a",
  "status": "stored",
  "cost_usd": 0.47,
  "cost_source": "reported"
}
```
<!-- iris:cost-log-response:end -->

### Cost Evaluation

`evaluate_output` with the `trace_id` and `eval_type: "cost"` runs the cost bundle on the stored run. It reads the cost, the token usage and the tool calls from the trace, so the request is two fields:

<!-- iris:cost-evaluate-request:start -->
```json
{
  "trace_id": "becb5935791b352b551ffec747a2199a",
  "eval_type": "cost"
}
```
<!-- iris:cost-evaluate-request:end -->

The server's answer, cut to the verdict, the rules that ran, the notes and the counts. The full response also carries an `id`, each rule's evidence, and a row for every rule that skipped, with its reason. The blocks on this page are written by `npm run skill-examples:render` from the server in this repository and checked on every change, so they are what the current version answers.

<!-- iris:cost-evaluate-response:start -->
```json
{
  "eval_type": "cost",
  "score": 0.714,
  "passed": true,
  "verdict": {
    "state": "pass",
    "basis": "clean",
    "by": []
  },
  "rule_results": [
    {
      "ruleName": "cost_under_threshold",
      "passed": false,
      "score": 0,
      "role": "advisory",
      "message": "Cost ($0.4700) exceeds threshold ($0.1000)"
    },
    {
      "ruleName": "verbosity_ratio",
      "passed": true,
      "score": 1,
      "role": "advisory",
      "message": "Token ratio (0.32) is within limits (max 5)"
    },
    {
      "ruleName": "no_tool_loop",
      "passed": true,
      "score": 1,
      "role": "risk",
      "message": "No repeated tool call (4 calls; most repeated ran 1×, max 3)"
    },
    {
      "ruleName": "max_steps",
      "passed": true,
      "score": 1,
      "role": "advisory",
      "message": "4 tool calls, within the budget of 50 (the shipped default, so this rule advises rather than gates)"
    }
  ],
  "interpretations": [
    {
      "text": "This evaluation is not the verdict of the trace: it ran one bundle rather than every bundle. It is kept beside trace becb5935791b352b551ffec747a2199a; the trace's verdict is unchanged. To score the trace as stored, call evaluate_output with its trace_id and none of output, input, tool_calls, tools, cost_usd, token_usage or eval_type."
    },
    {
      "rule": "cost_under_threshold",
      "text": "cost_under_threshold failed against a threshold Iris ships, not one you set, so it did not decide this verdict. Set it in your configuration to make it a gate, or set eval.defaultsGate to true to make every shipped default gate.",
      "configKey": "eval.defaultsGate"
    },
    {
      "text": "Risk estimate not yet confirmed by labelled data at this level; see iris-eval.com/proof. No labelled verdict had a risk estimate at this level."
    }
  ],
  "rules_evaluated": 4,
  "rules_skipped": 2
}
```
<!-- iris:cost-evaluate-response:end -->

How to read it:

- **`cost_under_threshold` failed.** The run cost $0.47, and the budget Iris ships is $0.10 a run.
- **`passed` is still `true`.** A budget Iris ships advises: nobody has told Iris what this agent may spend, so the rule reports, and its `role` reads `advisory`. `interpretations` says so in a sentence and names the setting.
- The other rows are the rest of the cost bundle, read from the same stored run.

## Setting your budget

A budget you set decides. Put it in `~/.iris/config.json` and restart the server:

<!-- iris:cost-config:start -->
```json
{
  "eval": {
    "ruleThresholds": {
      "cost_threshold": 0.25
    }
  }
}
```
<!-- iris:cost-config:end -->

The same two calls against that deployment answer:

<!-- iris:cost-evaluate-own-budget-response:start -->
```json
{
  "eval_type": "cost",
  "score": 0.749,
  "passed": false,
  "verdict": {
    "state": "fail",
    "basis": "policy_gate",
    "by": [
      "cost_under_threshold"
    ]
  },
  "rule_results": [
    {
      "ruleName": "cost_under_threshold",
      "passed": false,
      "score": 0.1200000000000001,
      "role": "gate",
      "message": "Cost ($0.4700) exceeds threshold ($0.2500)"
    },
    {
      "ruleName": "verbosity_ratio",
      "passed": true,
      "score": 1,
      "role": "advisory",
      "message": "Token ratio (0.32) is within limits (max 5)"
    },
    {
      "ruleName": "no_tool_loop",
      "passed": true,
      "score": 1,
      "role": "risk",
      "message": "No repeated tool call (4 calls; most repeated ran 1×, max 3)"
    },
    {
      "ruleName": "max_steps",
      "passed": true,
      "score": 1,
      "role": "advisory",
      "message": "4 tool calls, within the budget of 50 (the shipped default, so this rule advises rather than gates)"
    }
  ],
  "interpretations": [
    {
      "text": "This evaluation is not the verdict of the trace: it ran one bundle rather than every bundle. It is kept beside trace becb5935791b352b551ffec747a2199a; the trace's verdict is unchanged. To score the trace as stored, call evaluate_output with its trace_id and none of output, input, tool_calls, tools, cost_usd, token_usage or eval_type."
    }
  ],
  "rules_evaluated": 4,
  "rules_skipped": 2
}
```
<!-- iris:cost-evaluate-own-budget-response:end -->

Now the verdict fails. `verdict.basis` is `policy_gate`, `verdict.by` names `cost_under_threshold`, and the rule's `role` reads `gate`: $0.47 against the $0.25 you allowed.

For a budget on one bundle without editing the config file, deploy a `cost_threshold` rule with `deploy_rule`. At severity `high` or `critical` its failure fails the verdict:

<!-- iris:cost-deploy-request:start -->
```json
{
  "name": "retention_budget",
  "description": "A retention run may cost a quarter of a dollar.",
  "eval_type": "cost",
  "severity": "high",
  "definition": {
    "type": "cost_threshold",
    "config": {
      "max_cost": 0.25
    }
  }
}
```
<!-- iris:cost-deploy-request:end -->

A run with no cost, sent or stored, is not passed by either rule: the rule skips, and a skipped rule is left out of the score.

## Interpretation

The answer may be good and the run still too expensive: $0.47 is almost five times the budget Iris ships. That is a prompt to look at the agent:
- Can tool calls be batched?
- Is the retention model using too many tokens?
- Would a smaller model work for the data queries?

## Using get_traces for Trends

Call `get_traces` to find the most expensive recent runs (`sort_by` and `sort_order` are enums; there is no `filter` or `sort` argument):

<!-- iris:cost-traces-request:start -->
```json
{
  "sort_by": "cost_usd",
  "sort_order": "desc",
  "limit": 10,
  "include_summary": true
}
```
<!-- iris:cost-traces-request:end -->

This returns the most expensive recent traces, which shows you where to optimize first. With `include_summary: true` the response also carries a `summary` block — `total_traces`, `avg_latency_ms`, `total_cost_usd`, `error_rate`, `eval_pass_rate`, `traces_per_hour`, `top_agents` — so you can read the aggregate spend in the same call.
