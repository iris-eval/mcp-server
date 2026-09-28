# Trace cost: reported and estimated

Every trace Iris stores has a cost in USD, or no cost and the reason why. The cost comes from one of two places, and Iris records which one in `cost_source`:

| `cost_source` | Where the number came from |
|---|---|
| `reported` | The trace sent it: `cost_usd` on `log_trace`, `POST /api/v1/traces` or `iris-eval ingest`, or a cost attribute on its spans over OTLP (`iris.cost_usd`, `gen_ai.usage.cost`, `llm.usage.total_cost`). |
| `estimated` | The trace sent no cost, so Iris priced its token counts at the model's list price when it was stored. |

A reported cost always wins. Iris never replaces it and never estimates beside it. When there is neither, `cost_usd` is `null` and `cost_estimate` says why.

Most instrumentation sends token counts and a model name but no cost: the OpenTelemetry GenAI conventions, the `@iris-eval/sdk` and Python wrappers, and the LangChain handlers all record `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` and `gen_ai.request.model`. Before 0.20.0 those traces were stored without a cost, so the cost rules skipped them and the cost alert could not fire.

## How a cost is estimated

When a trace arrives through any door (`log_trace`, `POST /api/v1/traces`, `POST /v1/traces`, `iris-eval ingest`) and carries no cost:

1. **Model calls on spans.** A span carrying token counts is a model call. A parent that carries the same usage as its children is a total, not a call, so only the innermost carriers count (the same reading the OTLP door uses for the trace's token totals). Each call's model is the one its span names, `gen_ai.response.model` first and then `gen_ai.request.model`; a call that names none takes the model of its nearest ancestor, and then the trace's `metadata.model`.
   - If every call is priced as the same model, the trace's own `token_usage` is priced at that model, so the numbers the trace shows are the numbers priced.
   - If the calls are priced as more than one model, each call is priced at its own model and the results are added.
2. **No spans with token counts.** The trace's `token_usage` is priced at the model named in its `metadata.model`. Both `prompt_tokens` and `completion_tokens` are needed, because input and output tokens have different prices.
3. **No price.** If a model is not in the pricing table, or no model is named, or there are no token counts, the cost stays `null`. A trace with one unpriced call is not priced at all: a partial sum is too low, and a budget rule would pass a trace it should fail.

The estimate is rounded to ten decimal places. Every number it used is stored with it:

```json
{
  "cost_usd": 0.0285,
  "cost_source": "estimated",
  "cost_estimate": {
    "status": "estimated",
    "basis": "token_usage",
    "calls": [
      {
        "model": "gpt-4o-mini-2024-07-18",
        "priced_as": "gpt-4o-mini",
        "prompt_tokens": 150000,
        "completion_tokens": 10000,
        "input_usd_per_1m": 0.15,
        "output_usd_per_1m": 0.6,
        "cost_usd": 0.0285,
        "price_source": "iris",
        "price_as_of": "2026-09-25"
      }
    ]
  }
}
```

A trace with no cost carries the reason instead:

```json
{
  "cost_usd": null,
  "cost_estimate": {
    "status": "unpriced",
    "reason": "unknown_model",
    "models": ["gemini-2.5-flash"],
    "message": "No cost: the model \"gemini-2.5-flash\" is not in Iris's pricing table (as of 2026-09-25). Send cost_usd with the trace (or iris.cost_usd on a span), or price it under pricing.models in config.json."
  }
}
```

`reason` is one of `no_tokens`, `no_model`, `unknown_model` and `disabled` (estimates turned off in `config.json`).

## The pricing table

The built-in prices are the table in [llm-as-judge.md](llm-as-judge.md#models--pricing), the same one the LLM judge's cost cap uses, read from each provider's pricing page on **2026-09-25**. It prices Anthropic and OpenAI models.

A model id is matched in this order, and nothing else:

1. `pricing.models` in `config.json` (below), ignoring case, then with one provider prefix removed.
2. The built-in table, ignoring case.
3. With one provider prefix removed, `openai/`, `openai:`, `anthropic/` or `anthropic:`, when the prefix names the provider that sells the model. `openai/claude-sonnet-5` does not match.
4. A dated snapshot the provider prices the same as a model in the table:

| Snapshot | Priced as |
|---|---|
| `gpt-5-2025-08-07` | `gpt-5` |
| `gpt-5-mini-2025-08-07` | `gpt-5-mini` |
| `gpt-4.1-mini-2025-04-14` | `gpt-4.1-mini` |
| `gpt-4o-2024-08-06` | `gpt-4o` |
| `gpt-4o-2024-11-20` | `gpt-4o` |
| `gpt-4o-mini-2024-07-18` | `gpt-4o-mini` |
| `o4-mini-2025-04-16` | `o4-mini` |
| `o3-mini-2025-01-31` | `o3-mini` |
| `claude-sonnet-4-5-20250929` | `claude-sonnet-4-5` |
| `claude-opus-4-5-20251101` | `claude-opus-4-5` |

No date is removed by a rule, and no nearest name is taken. `gpt-4o-2024-05-13` is not in the list because OpenAI prices it at $5 / $15 per 1M tokens, twice `gpt-4o`. A snapshot that is not listed, a fine-tuned model (`ft:…`), an Amazon Bedrock id (`anthropic.claude-…-v1:0`) and a Google Cloud id (`claude-…@2025…`) are unknown models; those platforms set their own prices.

## Your own prices: `pricing` in `config.json`

```json
{
  "pricing": {
    "models": [
      { "model": "prod-gpt4o", "inputUsdPer1M": 2.75, "outputUsdPer1M": 11 },
      { "model": "llama-3.1-70b", "inputUsdPer1M": 0.6, "outputUsdPer1M": 0.8 }
    ],
    "asOf": "2026-09-01"
  }
}
```

| Key | Default | What it does |
|---|---|---|
| `pricing.estimate` | `true` | `false` turns estimates off: a trace that reports no cost is stored without one, with `reason: "disabled"`. |
| `pricing.models` | `[]` | Models to price that the built-in table does not know (a deployment name, another provider's model), or at another price than it lists (a negotiated rate). An entry wins over the built-in table for the same id. Ids are matched ignoring case, so two entries that differ only in case are refused at startup. |
| `pricing.asOf` | none | The date you read the prices in `pricing.models` (`YYYY-MM-DD`). It is stored with each estimate that used them and shown in the dashboard. |

The server and `iris-eval ingest` both read `config.json` from your Iris home, so a trace from a hook is priced the same as one sent to the server. `iris-eval --self-test` prints whether estimates are on, the built-in table's date and how many models `config.json` adds. `pricing.models` prices trace costs only; the LLM judge calls the provider and prices its own calls from the built-in table.

## What an estimate does not know

An estimate is the provider's list price for the token counts the trace recorded.

- **Reasoning tokens** are counted in the output tokens by both providers and are billed at the output rate, which is how Iris prices them.
- **Cached input** is not told apart. OpenAI counts cached tokens inside `prompt_tokens`, so they are priced at the full input rate and the estimate is high by the cache discount. Anthropic's API reports cache reads and writes outside `input_tokens`; when the instrumentation passes its counts through as they came, those tokens are not priced and the estimate is low by them.
- **Batch discounts, negotiated rates and a cloud platform's own prices** are not known. Set them in `pricing.models`, or send `cost_usd` with the trace.

## Where it shows

- **API and tools.** `log_trace`, `POST /api/v1/traces`, each trace in the answer from `POST /v1/traces`, and each line from `iris-eval ingest` carry `cost_usd`, `cost_source` and `cost_estimate`. So do `get_traces`, `GET /api/v1/traces`, `GET /api/v1/traces/:id` and `iris://traces/{trace_id}`. `GET /api/v1/summary` adds `estimated_cost_usd`, `GET /api/v1/eval-stats` adds `estimatedCost`, and the `cost_by_agent` view adds `estimatedTraces` and `estimatedCostUsd`: the estimated part of each total.
- **Rules.** `cost_under_threshold`, `cost_anomaly` and a custom `cost_threshold` rule judge an estimated cost like a reported one. Their message ends with what was estimated, for example `(estimated by Iris: 150,000 input and 10,000 output tokens at gpt-4o-mini list price as of 2026-09-25; the trace reported no cost)`, and their cost evidence carries `costSource: "estimated"`. `evaluate_output` with a `trace_id` and no `cost_usd` uses the trace's stored cost.
- **Alerts.** The `cost_anomaly` webhook's `detail` carries `cost_source`, and its summary is the rule's message.
- **Dashboard.** An estimated cost is followed by **est.** in the trace list, on the trace page, in the live stream and on the moments. Its tooltip names the tokens, the model it was priced as and the date of the prices. On the trace page, a trace with no cost says why. The total-cost tile names the estimated part.

## Traces stored before 0.20.0

Upgrading adds two columns (migration 016) and rewrites nothing: it took 6 ms on a file of 100,000 traces. Every cost stored before is read as `reported`, because no earlier version estimated one. Traces stored without a cost stay without one: Iris does not estimate past traces at today's prices. Traces stored after the upgrade are estimated, so cost totals, `cost_under_threshold` and `cost_anomaly` start covering traces that used to be skipped.
