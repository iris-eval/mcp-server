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
   - If every call is priced as the same model, the trace's own `token_usage` is priced at that model, so the numbers the trace shows are the numbers priced. The exception is a call over the size at which its provider prices a request higher (below): a total cannot carry that, so each call is then priced on its own, and what `token_usage` records beyond those calls is priced as one more total, at the base rates, with a note that says so.
   - If the calls are priced as more than one model, each call is priced at its own model and the results are added.
2. **No spans with token counts.** The trace's `token_usage` is priced at the model named in its `metadata.model`. Both `prompt_tokens` and `completion_tokens` are needed, because input and output tokens have different prices.
3. **No price.** If a model is not in the pricing table, or no model is named, or there are no token counts, the cost stays `null`. A trace with one unpriced call is not priced at all: a partial sum is too low, and a budget rule would pass a trace it should fail.

## Cached input

Input tokens read from or written to the prompt cache are priced as the provider bills them, when the trace says how many there were. The rest of the input is priced at the input price.

| The trace carries | Read from |
|---|---|
| cache reads | `gen_ai.usage.cache_read.input_tokens` on a span (what the `@iris-eval/sdk` and Python wrappers and both LangChain handlers send), `gen_ai.usage.cache_read_input_tokens`, OpenInference's `llm.token_count.prompt_details.cache_read`, or `token_usage.cache_read_tokens` (OpenAI's `token_usage.prompt_tokens_details.cached_tokens` is read as it) |
| cache writes | `gen_ai.usage.cache_creation.input_tokens`, `gen_ai.usage.cache_creation_input_tokens`, `llm.token_count.prompt_details.cache_write`, or `token_usage.cache_creation_tokens` |
| of the writes, the 1-hour ones | `iris.usage.cache_creation.ephemeral_1h_input_tokens` (the SDK and Python wrappers send it from Anthropic's `usage.cache_creation.ephemeral_1h_input_tokens`, and both LangChain handlers from LangChain's usage details; no GenAI convention names it yet), or `token_usage.cache_creation_1h_tokens` |

- **The cached counts are a part of the input count.** The GenAI conventions, OpenInference and OpenAI all define them that way, and Iris's own wrappers and handlers record them that way, folding Anthropic's separate counts into the input count.
- **Anthropic's API reports them beside `input_tokens`.** An instrumentation that passes that shape through can be told apart only when the cached counts are larger than the input count, because a part never is. Then they are added to the input count, and `cost_estimate.notes` says so. A cached count no larger than the input is read as a part.
- **Prices.** Anthropic's cache reads are priced at its cache-hit price. Its writes are priced at the 5-minute write price (1.25 times the input), and the 1-hour ones at the 1-hour price (2 times) when the trace says how many there were. Without that split every write is priced as a 5-minute write, and `cost_estimate.notes` says the estimate may be low by the 1-hour ones. OpenAI charges for a write from GPT-5.6, and a write is priced at its 30-minute price (1.25 times the input); its earlier models charge nothing extra to write the cache, so a written token costs an input token.
- **A model priced in `config.json` without `cacheReadUsdPer1M` or `cacheWriteUsdPer1M`.** Its cached tokens are priced at its input price, as before cache prices existed, and `cost_estimate.notes` says which.

On a gpt-4o-mini call with 150,000 input tokens, 100,000 of them cache reads, and 10,000 output tokens, the estimate is $0.021. Priced at the full input rate, it would be $0.0285. On a claude-sonnet-5 call with 2,000 input tokens, 100,000 cache reads, 20,000 cache writes and 1,000 output tokens, it is $0.084, not $0.254.

## Requests priced by their size

Some models cost more per token when a request is large, and then for the whole request: Claude Haiku 5.5 over 100,000 prompt tokens, and OpenAI's GPT-5.4, GPT-5.5, GPT-5.6 and GPT-6 over 272,000 input tokens (twice the input and cache rates, 1.5 times the output). A request's size counts every input token, its cache reads and writes included. The rates are in the Notes column of the [table](llm-as-judge.md#models--pricing).

- **A call on a span** is priced by its own size: over the line, every token of it at the higher rates, and `cost_estimate.notes` says so. Its `input_usd_per_1m` and `output_usd_per_1m` are the rates it was priced at.
- **A total** (the trace's `token_usage`, or a span that carries a whole run's usage) cannot say whether any one call was over the line. It is priced at the base rates, and when the total is over the line and the calls on the spans do not account for it, each under the line, `cost_estimate.notes` says the estimate may be low.
- **A price from `config.json`** is one rate at every size.

## What is stored

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
        "price_as_of": "2026-11-18"
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
    "message": "No cost: the model \"gemini-2.5-flash\" is not in Iris's pricing table (as of 2026-11-18). Send cost_usd with the trace (or iris.cost_usd on a span), or price it under pricing.models in config.json."
  }
}
```

`reason` is one of `no_tokens`, `no_model`, `unknown_model` and `disabled` (estimates turned off in `config.json`).

A call that used the prompt cache also carries `cache_read_tokens`, `cache_creation_tokens`, `cache_read_usd_per_1m` and `cache_write_usd_per_1m`, and, when the trace split its writes, `cache_creation_1h_tokens` and `cache_write_1h_usd_per_1m`. `prompt_tokens` counts every input token, the cached ones included. An estimate that priced anything other than as the provider bills it lists why in `notes`.

## The pricing table

The built-in prices are the table in [llm-as-judge.md](llm-as-judge.md#models--pricing), the same one the LLM judge's cost cap uses, read from each provider's pricing page on **2026-11-18**. It prices Anthropic and OpenAI models.

A model id is matched in this order, and nothing else:

1. `pricing.models` in `config.json` (below), ignoring case, then with one provider prefix removed.
2. The built-in table, ignoring case.
3. With one provider prefix removed, `openai/`, `openai:`, `anthropic/` or `anthropic:`, when the prefix names the provider that sells the model. `openai/claude-sonnet-5` does not match.
4. A dated snapshot the provider prices the same as a model in the table:

| Snapshot | Priced as |
|---|---|
| `gpt-5.5-2026-04-23` | `gpt-5.5` |
| `gpt-5.4-2026-03-05` | `gpt-5.4` |
| `gpt-5.4-mini-2026-03-17` | `gpt-5.4-mini` |
| `gpt-5.4-nano-2026-03-17` | `gpt-5.4-nano` |
| `gpt-5.2-2025-12-11` | `gpt-5.2` |
| `gpt-5.1-2025-11-13` | `gpt-5.1` |
| `gpt-5-2025-08-07` | `gpt-5` |
| `gpt-5-mini-2025-08-07` | `gpt-5-mini` |
| `gpt-5-nano-2025-08-07` | `gpt-5-nano` |
| `gpt-4.1-2025-04-14` | `gpt-4.1` |
| `gpt-4.1-mini-2025-04-14` | `gpt-4.1-mini` |
| `gpt-4o-2024-08-06` | `gpt-4o` |
| `gpt-4o-2024-11-20` | `gpt-4o` |
| `gpt-4o-mini-2024-07-18` | `gpt-4o-mini` |
| `o4-mini-2025-04-16` | `o4-mini` |
| `o3-2025-04-16` | `o3` |
| `o3-mini-2025-01-31` | `o3-mini` |
| `o1-mini-2024-09-12` | `o1-mini` |
| `claude-sonnet-4-5-20250929` | `claude-sonnet-4-5` |
| `claude-opus-4-5-20251101` | `claude-opus-4-5` |

No date is removed by a rule, and no nearest name is taken. `gpt-4o-2024-05-13` is not in the list because OpenAI prices it at $5 / $15 per 1M tokens, twice `gpt-4o`. A snapshot that is not listed, a fine-tuned model (`ft:…`), an Amazon Bedrock id (`anthropic.claude-…-v1:0`) and a Google Cloud id (`claude-…@2025…`) are unknown models; those platforms set their own prices.

## Your own prices: `pricing` in `config.json`

```json
{
  "pricing": {
    "models": [
      { "model": "prod-gpt4o", "inputUsdPer1M": 2.75, "outputUsdPer1M": 11, "cacheReadUsdPer1M": 1.375 },
      { "model": "llama-3.1-70b", "inputUsdPer1M": 0.6, "outputUsdPer1M": 0.8 }
    ],
    "asOf": "2026-09-01"
  }
}
```

| Key | Default | What it does |
|---|---|---|
| `pricing.estimate` | `true` | `false` turns estimates off: a trace that reports no cost is stored without one, with `reason: "disabled"`. |
| `pricing.models` | `[]` | Models to price that the built-in table does not know (a deployment name, another provider's model), or at another price than it lists (a negotiated rate). Each entry has `model`, `inputUsdPer1M` and `outputUsdPer1M`, and optionally `cacheReadUsdPer1M`, `cacheWriteUsdPer1M` and `cacheWrite1hUsdPer1M`. An entry wins over the built-in table for the same id. Ids are matched ignoring case, so two entries that differ only in case are refused at startup. |
| `pricing.asOf` | none | The date you read the prices in `pricing.models` (`YYYY-MM-DD`). It is stored with each estimate that used them and shown in the dashboard. |

The server and `iris-eval ingest` both read `config.json` from your Iris home, so a trace from a hook is priced the same as one sent to the server. `iris-eval --self-test` prints whether estimates are on, the built-in table's date and how many models `config.json` adds. `pricing.models` prices trace costs only; the LLM judge calls the provider and prices its own calls from the built-in table.

## What an estimate does not know

An estimate is the provider's list price for the token counts the trace recorded.

- **Reasoning tokens** are counted in the output tokens by both providers and are billed at the output rate, which is how Iris prices them.
- **A 1-hour cache write** from an instrumentation that does not report the write lifetimes is priced as a 5-minute write (1.25 times the input price, where Anthropic charges 2 times), and the notes say so. Iris's own wrappers and LangChain handlers report them.
- **A 12-hour cache write** on OpenAI is priced as a 30-minute write (1.25 times the input price, where OpenAI charges 2.5 times): no field Iris reads splits the two.
- **An OpenAI cache write recorded by Iris's own wrappers.** The `@iris-eval/sdk` and Python wrappers record OpenAI's cache reads, not its writes (`cache_write_tokens`), so on GPT-5.6 and later, where a write costs 1.25 times the input, a trace they send prices its written tokens as input, and the notes do not say so.
- **A call over the size its provider prices higher**, inside a total that does not say how large each call was, is priced at the base rates; the notes say so when the total is over the line.
- **Batch discounts, negotiated rates and a cloud platform's own prices** are not known. Set them in `pricing.models`, or send `cost_usd` with the trace.

## Where it shows

- **API and tools.** `log_trace`, `POST /api/v1/traces`, each trace in the answer from `POST /v1/traces`, and each line from `iris-eval ingest` carry `cost_usd`, `cost_source` and `cost_estimate`. So do `get_traces`, `GET /api/v1/traces`, `GET /api/v1/traces/:id` and `iris://traces/{trace_id}`. `GET /api/v1/summary` adds `estimated_cost_usd`, `GET /api/v1/eval-stats` adds `estimatedCost`, and the `cost_by_agent` view adds `estimatedTraces` and `estimatedCostUsd`: the estimated part of each total.
- **Rules.** `cost_under_threshold`, `cost_anomaly` and a custom `cost_threshold` rule judge an estimated cost like a reported one. Their message ends with what was estimated, for example `(estimated by Iris: 150,000 input and 10,000 output tokens at gpt-4o-mini list price as of 2026-11-18; the trace reported no cost)`, and their cost evidence carries `costSource: "estimated"`. `evaluate_output` with a `trace_id` and no `cost_usd` uses the trace's stored cost.
- **Alerts.** The `cost_anomaly` webhook's `detail` carries `cost_source`, and its summary is the rule's message.
- **Dashboard.** An estimated cost is followed by **est.** in the trace list, on the trace page, in the live stream and on the moments. Its tooltip names the tokens, the model it was priced as and the date of the prices. On the trace page, a trace with no cost says why. The total-cost tile names the estimated part.

## Traces stored before 0.20.0

Upgrading adds two columns (migration 016) and rewrites nothing: it took 6 ms on a file of 100,000 traces. Every cost stored before is read as `reported`, because no earlier version estimated one. Traces stored without a cost stay without one: Iris does not estimate past traces at today's prices. Traces stored after the upgrade are estimated, so cost totals, `cost_under_threshold` and `cost_anomaly` start covering traces that used to be skipped.
