# HTTP Ingest

`POST /api/v1/traces` stores a trace over plain HTTP — the deterministic capture path.
The MCP `log_trace` tool only fires when the model *chooses* to call it; this endpoint
fires when **your code** calls it. Same body, same storage row, same dashboard.

The endpoint lives on the dashboard server, so it sits behind the full middleware
stack: loopback bind (`127.0.0.1` by default), the DNS-rebinding guard (hostile
`Origin`/`Host` headers are rejected with `403` before anything is written), optional
Bearer auth, and the shared API rate limiter.

---

## TL;DR

```bash
# Start Iris with the dashboard (default port 6920, loopback only)
npx @iris-eval/mcp-server --dashboard
```

```bash
curl -s -X POST "http://127.0.0.1:6920/api/v1/traces" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_name": "support-bot",
    "input": "What is the refund policy?",
    "output": "Refunds are available within 30 days of purchase.",
    "latency_ms": 812,
    "token_usage": { "prompt_tokens": 120, "completion_tokens": 40, "total_tokens": 160 },
    "evaluate": true,
    "eval_type": "safety"
  }'
```

```json
{
  "trace_id": "3f2a9c…32 hex chars…",
  "status": "stored",
  "evaluation": {
    "id": "…uuid…",
    "eval_type": "safety",
    "score": 1,
    "passed": true,
    "rule_results": [ … ],
    "suggestions": [],
    "rules_evaluated": …,
    "rules_skipped": …,
    "insufficient_data": false
  }
}
```

---

## Request body

The body is the **`log_trace` tool contract** — the two capture paths validate
against the same schema, so anything `log_trace` accepts, this endpoint accepts.
Plus two HTTP-only fields:

| Field | Type | Notes |
|---|---|---|
| `agent_name` | string | **required** — everything else is optional |
| `framework` | string | e.g. `openai`, `langchain`, `custom` |
| `input` / `output` | string | the text pair evals run against |
| `tool_calls` | array | `{ tool_name, input?, output?, latency_ms?, error? }` |
| `latency_ms` | number | end-to-end latency |
| `token_usage` | object | `{ prompt_tokens?, completion_tokens?, total_tokens? }` |
| `cost_usd` | number | authoritative when provided |
| `metadata` | object | opaque key-value tags |
| `spans` | array | span tree; `span_id` minted server-side when omitted |
| `timestamp` | string | ISO 8601; defaults to now |
| `evaluate` | boolean | HTTP-only. `true` runs the deterministic eval engine on `output` and stores the result linked to the trace. Requires `output`. |
| `eval_type` | enum | HTTP-only. `completeness` (default) \| `relevance` \| `safety` \| `cost` \| `custom` |

`trace_id` is **server-minted, never client-supplied** — one in the body is ignored.
Each POST creates a new trace (not idempotent), mirroring `log_trace`.

Note: `relevance` needs an `expected` comparison target, which the trace shape does
not carry — those rules report as skipped. Use `completeness`, `safety`, or `cost`
for ingest-time evaluation; run `evaluate_output` with `expected` for relevance.

## Responses

| Status | Meaning |
|---|---|
| `201` | Stored. Body: `{ "trace_id": "<32-hex>", "status": "stored" }`, plus `"evaluation": { … }` when `evaluate: true` |
| `400` | Invalid body. `{ "error": "Invalid trace payload", "details": [ …zod issues… ] }` |
| `401` / `403` | Missing / wrong `Authorization: Bearer <key>` when the server was started with an API key. `403` is also the rebinding guard rejecting a hostile `Origin`/`Host` |
| `413` | Body over the configured request size limit (default `1mb`) |
| `429` | Shared API rate limit exceeded — back off and retry |
| `501` | `evaluate: true` on a server with no eval engine wired (embedders). The trace is **not** stored — retry without `evaluate` |

## Discovery

On bind, the dashboard writes `${IRIS_HOME:-~/.iris}/runtime.json`:

```json
{ "dashboardPort": 6920, "pid": 12345, "startedAt": "2026-08-11T12:00:00.000Z" }
```

Capture clients can read it to find the port instead of hardcoding one. The file can
go stale after an unclean exit — verify with `GET /api/v1/health` (always auth-exempt)
before trusting it.

## Notes

- When `IRIS_OTEL_ENDPOINT` is set, ingested traces get the same best-effort async
  OTel export as `log_trace` (see [otel-integration.md](otel-integration.md)).
- Windows Git Bash: keep the URL quoted (`"http://127.0.0.1:6920/api/v1/traces"`) —
  unquoted special characters mangle paths.
- Rate limiting shares the dashboard API bucket. A very chatty producer can 429
  itself; batch or back off client-side.
