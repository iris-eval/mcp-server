# HTTP Ingest

`POST /api/v1/traces` stores a trace over plain HTTP — the deterministic capture path.
The MCP `log_trace` tool only fires when the model *chooses* to call it; this endpoint
fires when **your code** calls it. Same body, same storage row, same dashboard.

The endpoint lives on the **dashboard server** (default port `6920`), not on the MCP
transport port, so it sits behind the full middleware stack: loopback bind (`127.0.0.1`
by default), the DNS-rebinding guard (hostile `Origin`/`Host` headers are rejected with
`403` before anything is written), optional Bearer auth, and the shared API rate limiter.

**It exists only while the dashboard is running.** Pass `--dashboard`, set
`IRIS_DASHBOARD=true`, or set `dashboard.enabled: true` in `config.json`. Since v0.5.0
the dashboard does **not** start implicitly with `--transport http` — a server started
with `--transport http` alone serves `/mcp` on port `3000` and logs a line saying how
to turn the dashboard on; `POST /api/v1/traces` is not there until you do.

Two things to know before pointing production traffic at it:

- **Writes are unauthenticated unless you set `--api-key` (or `IRIS_API_KEY`).** With
  no key, anything that can reach the dashboard port can store traces. The loopback
  bind and the rebinding guard are what keep that to your own machine by default; if
  you bind beyond loopback (`--dashboard-host`), set a key. With a key set, API clients
  — this endpoint included — send `Authorization: Bearer <key>`; a browser opening the
  dashboard UI signs in once with `?key=<api key>` on any dashboard URL instead (see
  [api-reference.md → Dashboard API Routes](api-reference.md#dashboard-api-routes)).
- **Stored text is verbatim.** `input` and `output` land in `iris.db` exactly as sent,
  including anything `no_pii` goes on to flag. Traces and evaluations older than
  `retention.days` (default 30, `0` disables, in `config.json`) are deleted at startup;
  `--purge` removes everything stored and compacts the file. There is no other redaction.
- **Demo mode refuses ingest.** A server started with `--demo` answers `403` here, so
  demo data never mixes with yours — start the real server (`--dashboard`) to store
  your own traces.

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
| `eval_type` | enum | HTTP-only. `completeness` (default) \| `relevance` \| `safety` \| `cost` \| `custom` \| `all`. `all` runs every bundle in one pass — the critical veto spans all of them — and adds a per-bundle `categories` map to the evaluation, exactly as the `evaluate_output` tool does; the result is stored under `eval_type: "all"` |

`trace_id` is **server-minted, never client-supplied** — one in the body is **rejected
with `400`**, and the message says the server mints it. Read the id from the `201`
response. The body is strict: any unknown key (a misspelled `eval_typ`, say) is
rejected the same way rather than silently dropped. Each POST creates a new trace
(not idempotent), mirroring `log_trace`.

Note: the `relevance` rules compare `output` against `input` (keyword overlap and
topic consistency) — send `input`, or both report as skipped. The trace shape carries
no `expected`, so the completeness bundle's `expected_coverage` rule always skips
here; run `evaluate_output` with `expected` when you need that one.

## Responses

| Status | Meaning |
|---|---|
| `201` | Stored. Body: `{ "trace_id": "<32-hex>", "status": "stored" }`, plus `"evaluation": { … }` when `evaluate: true` (carrying `critical_failures` / `critical_skipped` when a critical rule failed or skipped, and `categories` when `eval_type` is `all`) |
| `400` | Invalid body — a missing `agent_name`, a malformed span, an unknown or misspelled key, or a client-supplied `trace_id`. `{ "error": "Invalid trace payload", "details": [ …zod issues… ] }` |
| `401` / `403` | Missing / wrong `Authorization: Bearer <key>` when the server was started with an API key. `403` is also the rebinding guard rejecting a hostile `Origin`/`Host`, and the answer in `--demo` mode, which refuses ingest |
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
