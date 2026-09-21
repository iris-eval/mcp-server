# OpenTelemetry Integration

Two directions. **Out** (since 0.4): every `log_trace` is exported to the OTLP/HTTP collector you name. **In** (0.15.0): the spans your instrumentation already emits arrive at `POST /v1/traces` and become Iris traces — see [Traces arrive by OTLP](#traces-arrive-by-otlp) below.

Iris can export every `log_trace` call to any OpenTelemetry collector that speaks **OTLP/HTTP**
with **JSON encoding**. The export is a best-effort side effect — Iris always stores the trace
locally first, then fires an async export in the background. Collector failures never block
the tool response.

---

## TL;DR

```bash
# Point at any OTLP/HTTP collector
export IRIS_OTEL_ENDPOINT=https://otel.your-company.com:4318

# Optional: service name (defaults to iris-eval)
export IRIS_OTEL_SERVICE_NAME=iris-prod

# Optional: auth headers (for Datadog, Honeycomb, Grafana Cloud, etc.)
export IRIS_OTEL_HEADERS="authorization=Bearer sk-abc, x-team=platform"

# Run Iris normally
iris-eval --transport http --dashboard
```

Every `log_trace` now also emits an OTLP `ExportTraceServiceRequest` to
`$IRIS_OTEL_ENDPOINT/v1/traces`.

---

## Supported backends

Any backend accepting **OTLP/HTTP JSON** at `/v1/traces`:

| Backend                          | Endpoint example                                             | Extra headers                           |
|----------------------------------|--------------------------------------------------------------|-----------------------------------------|
| OTEL Collector (self-hosted)     | `http://localhost:4318`                                      | —                                       |
| Jaeger                           | `http://localhost:4318`                                      | —                                       |
| Grafana Tempo                    | `http://tempo.your-company.com:4318`                         | Basic auth if configured                |
| Datadog OTLP                     | `https://api.datadoghq.com/api/intake/otlp/v1/traces`        | `dd-api-key=<your-key>`                 |
| Honeycomb                        | `https://api.honeycomb.io:443`                               | `x-honeycomb-team=<your-key>`           |
| Grafana Cloud Traces             | `https://tempo-prod-XX-prod-us-east-0.grafana.net/tempo`     | `authorization=Basic <base64 user:key>` |
| New Relic OTLP                   | `https://otlp.nr-data.net:4318`                              | `api-key=<your-license-key>`            |

gRPC transport is **not supported in v0.4** — front gRPC-only receivers with an OTel Collector
configured to accept HTTP and forward to gRPC. This keeps Iris's dependency surface minimal
(no `@opentelemetry/*` packages — we use native `fetch` against the documented OTLP spec).

---

## What gets exported

Each Iris trace becomes one OTLP `ResourceSpans` entry with:

- **Resource attributes**: `service.name`, `telemetry.sdk.name=iris-eval`, `telemetry.sdk.language=nodejs`, `telemetry.sdk.version=<running release>` (sourced from `package.json` at runtime)
- **Scope**: `iris.trace.v1`
- **Spans**: either the `spans[]` tree you sent (hierarchical), or a synthesized root span built from trace-level fields when no span tree is present

### Attribute mapping

Iris attribute types are flattened to OTel `AnyValue`:

| JS type             | OTLP shape                                  |
|---------------------|---------------------------------------------|
| `string`            | `{stringValue}`                             |
| `boolean`           | `{boolValue}`                               |
| integer `number`    | `{intValue: "..."}` (decimal string)        |
| float `number`      | `{doubleValue}`                             |
| `Array`             | `{arrayValue: {values: [...]}}`             |
| object              | `{kvlistValue: {values: [{key, value}]}}`   |
| null / undefined    | falls back to `{stringValue}`               |

Iris-specific span kinds (`LLM`, `TOOL`) are mapped to `INTERNAL` on the OTel side and surfaced
as an `iris.span_kind` attribute so downstream queries can filter on them. Trace + span IDs are
hex-normalized (32 hex for trace, 16 hex for span). When Iris has produced a non-hex ID (e.g.
`mcp-abc-123`), we deterministically hash to the target length so OTel consumers always see a
valid identifier.

---

## Trace-level synthesis

If a trace has no `spans[]` tree, Iris synthesizes a single root span named after the agent
with these attributes:

- `iris.agent_name`
- `iris.framework` (if set)
- `iris.input` (truncated to 4096 chars with `…`)
- `iris.output` (truncated)
- `iris.cost_usd`
- `iris.total_tokens` / `iris.prompt_tokens` / `iris.completion_tokens`

Start time is the trace timestamp; end time is `start + latency_ms` (falls back to start if
`latency_ms` missing).

---

## Failure behavior

Iris never fails the `log_trace` tool response because the OTel collector is down.

- **Endpoint unreachable** → one `console.warn("[iris.otel] OTel export failed: ...")` line on stderr per trace
- **HTTP 5xx** → logged to stderr, trace is still stored locally
- **Auth failure (401/403)** → logged to stderr; usually indicates a bad `IRIS_OTEL_HEADERS` value
- **Timeout (>15s default, or `IRIS_OTEL_TIMEOUT_MS`)** → logged; `log_trace` has already returned

If you need guaranteed delivery (every trace reaches the backend), put an OTel Collector
in front of the backend with an on-disk queue (the Collector's `file_storage` extension or
the Sentinel/Kafka exporter).

---

## Debugging

### Verify traces are reaching the collector

```bash
# Point Iris at a local debug collector
export IRIS_OTEL_ENDPOINT=http://localhost:4318

# Run any OTEL Collector with the debug exporter:
docker run -p 4318:4318 otel/opentelemetry-collector \
  --config=/etc/otelcol/config.yaml
```

Confirm spans appear in the collector's debug output.

### Check Iris stderr

```
[iris.otel] OTel export failed: status=503 upstream broken
```

This line appears for each failed export. Absence of warnings + storage still working = happy path.

### Inspect the wire payload

```bash
# Point Iris at a local HTTP echo server
export IRIS_OTEL_ENDPOINT=http://localhost:8080

# Run httpecho or equivalent
python3 -m http.server 8080 2>&1 | tee /tmp/otel-payloads.log
```

You'll see raw POSTs to `/v1/traces` with JSON bodies matching
[the OTLP spec](https://opentelemetry.io/docs/specs/otlp/#otlphttp-json-encoding).

---

## Design rationale

**Why hand-rolled instead of `@opentelemetry/sdk-node`?**
Three reasons. (1) Supply-chain surface — the SDK pulls in ~30 transitive deps (`semver`, `shimmer`, async-hooks integrations). Iris uses plain `fetch`. (2) Wire format stability — the OTLP JSON format is frozen by the OTel spec and we follow it byte-for-byte; we don't need API-stability guarantees from a vendor SDK. (3) Consistency — Iris already uses hand-rolled HTTP for LLM providers (`src/eval/llm-judge/client.ts`) and citation resolution (`src/eval/citation-verify/resolve.ts`); this module fits the same pattern.

**Why OTLP/HTTP JSON and protobuf, not gRPC?**
gRPC would require `@grpc/grpc-js` + `@opentelemetry/proto` — back to the SDK footprint. JSON-over-HTTP is supported by every OTel collector, is trivially debuggable with `curl`, and is the path of least dependency — so the export side speaks JSON. The ingest door (`POST /v1/traces`) accepts protobuf too, since 0.16.0: the Python OTLP exporter sends protobuf only (its JSON encoding is not implemented — the spec's compliance matrix says so), so a JSON-only door meant every Python framework needed a Collector in between. Three ways to read protobuf were compared — `protobufjs` (reflection over vendored `.proto` files, 3.8 MB unpacked), `@bufbuild/protobuf` (generated code and a build step, 1.9 MB), or a wire-format reader for the one message Iris accepts — and `src/otel/protobuf.ts` is the third: about two hundred lines, no dependency, held by its test to reproducing the real Python exporter's payloads exactly as protobuf's own JSON mapping renders them (`tests/fixtures/otlp/`).

**Why best-effort fire-and-forget instead of an in-memory queue?**
The MCP server is mostly synchronous from the agent's perspective — agents call `log_trace` and wait for the response. Introducing a background queue adds lifecycle complexity (drain on shutdown, retry logic, deduplication) for questionable benefit. If operators need guaranteed delivery they should front Iris with an OTel Collector running `file_storage` — that's the right layer for durability. Iris's job is "emit the telemetry"; the Collector's job is "guarantee it lands."

**Why export on every `log_trace` rather than batching?**
log_trace calls are individually interesting signals — unlike auto-instrumented HTTP spans where batching wins, each agent execution is user-initiated and operationally important. Per-trace POSTs at the volume an MCP agent produces (10-1000/day per agent) are well within any collector's capacity. Batching would add complexity without a clear win.

**Why synthesize a root span when no span tree is present?**
Without it, traces with only top-level fields (many quick agent calls have no span tree) would export as empty `ResourceSpans` entries. Downstream tooling expects at least one span per trace; synthesizing one keeps Iris's wire contract sane for the consumer.

---

## Trace context is carried (SEP-414)

MCP's SEP-414 (Final) puts W3C trace context in a request's `_meta`: `traceparent`, `tracestate`, `baggage`. Iris reads them on `log_trace` and `evaluate_output` (from `_meta`, with the MCP session id when the transport has one) and on `POST /api/v1/traces` and `POST /v1/traces` (from the headers of the same names) and stores what arrived under `metadata.trace_context` — the header as sent, its trace id, the caller's parent span id, the sampled flag and the MCP session id. `evaluate_output` writes the context onto the trace it is linked to (`trace_id`) when that trace carries none yet; without a `trace_id` there is no trace to carry it. The API returns it with the trace and the trace drawer shows it under Metadata. When Iris exports to `IRIS_OTEL_ENDPOINT`, a trace stored with a context is exported **under the caller's trace id with its root span parented to the caller's span**, so the evaluation shows up inside the agent's own trace in Langfuse, Phoenix, Logfire or Jaeger rather than beside it. A root that joined the caller's trace also carries `mcp.method.name: tools/call` and, when known, `mcp.session.id`, per the OpenTelemetry MCP semantic conventions. A request without a context stores none, and the export carries Iris's own ids and attributes exactly as before. Iris reads the context and never mints one; a malformed `traceparent` (wrong shape, all-zero ids, version `ff`) is ignored, not refused.

One client to know about: Claude Code sends `_meta` as null on `tools/call` (anthropics/claude-code#76391, closed as not planned), so from that client the hook-based capture plugin is the session link, not `_meta`.

## Traces arrive by OTLP

`POST /v1/traces` on the dashboard port accepts an OTLP/HTTP `ExportTraceServiceRequest` as **JSON** (`Content-Type: application/json`) or **protobuf** (`application/x-protobuf`, since 0.16.0) — the path every OTLP exporter already posts to, so pointing a Collector's `otlphttp` exporter (either `encoding`) or an SDK's `OTEL_EXPORTER_OTLP_ENDPOINT` at `http://<iris>:6920` is the whole integration — for the Python SDK too, whose exporter sends protobuf only. It sits behind the same API key, DNS-rebinding guard and rate limit as the REST API; any other content type is answered `415` naming both encodings; a body that is not an `ExportTraceServiceRequest` is `400` (for protobuf, with the byte offset of what went wrong). gRPC is not served: a Collector bridges it —

```yaml
# otel-collector.yaml — gRPC in, Iris out
receivers:
  otlp:
    protocols:
      grpc:
exporters:
  otlphttp/iris:
    endpoint: http://127.0.0.1:6920
    headers:
      authorization: Bearer ${env:IRIS_API_KEY}
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlphttp/iris]
```

Each OTLP trace id becomes one Iris trace with its spans, read from the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) and Iris's own export attributes:

| Trace field | Read from, in order |
|---|---|
| `agent_name` | resource `service.name`; `iris.agent_name`; `gen_ai.agent.name` on any span (ADK, Agent Framework, AutoGen, Pydantic AI); else `"otel"` (and the answer says it lacked `service.name`) |
| `input` | `iris.input`, `gen_ai.input.messages`, `gen_ai.prompt`, OpenInference `input.value`, Traceloop `traceloop.entity.input`, Vercel `ai.prompt` — on the root span, then any span in start order; then Traceloop's indexed `gen_ai.prompt.N.content` joined in order; then a `gen_ai.content.prompt` event |
| `output` | the same for `iris.output`, `gen_ai.output.messages`, `gen_ai.completion`, `output.value`, `traceloop.entity.output`, `ai.response.text`, indexed `gen_ai.completion.N.content`, `gen_ai.content.completion` |
| `metadata.model` | `gen_ai.request.model`, `gen_ai.response.model`, OpenInference `llm.model_name`, `llm.request.model`, Vercel `ai.model.id` — what the judge's same-family check reads |
| `session_id` | resource or span `gen_ai.conversation.id`, `session.id` — the trace's session (arc 9, N-15): the drawer shows the other turns, `GET /api/v1/traces?session=` lists them |
| `tools` | `gen_ai.tool.definitions` (a JSON list of `{ name, description, inputSchema \| parameters }`) — the catalogue `valid_tool_arguments` checks against |
| `token_usage` | `gen_ai.usage.input_tokens` / `output_tokens` (the older `prompt_tokens` / `completion_tokens`, `iris.*_tokens`, OpenInference `llm.token_count.prompt` / `completion`, Semantic Kernel `gen_ai.response.prompt_tokens` / `completion_tokens`, Vercel `ai.usage.promptTokens` / `completionTokens`) — summed over the LEAF carriers only, so a framework that puts the run's totals on `invoke_agent` beside `chat` children that carry their own is counted once; Pydantic AI's whole-run `gen_ai.aggregated_usage.*` is the answer when present |
| `cost_usd` | `iris.cost_usd`, `gen_ai.usage.cost`, `llm.usage.total_cost`, summed |
| `run`, `case_key` | `iris.run`, `iris.case_key` on the resource or the root span |
| `timestamp`, `latency_ms` | the root span's start, and its end minus start |
| `spans[]` | every span; kind `TOOL` when it carries `gen_ai.tool.*` / `tool.name` / `ai.toolCall.name`, `gen_ai.operation.name = execute_tool`, `openinference.span.kind = TOOL`, `langsmith.span.kind = tool` or `traceloop.span.kind = tool`; `LLM` when it carries a GenAI request attribute (`gen_ai.request.model`, `llm.model_name`, `ai.model.id`, `llm.request.type` …), `openinference.span.kind = LLM` or `langsmith.span.kind = llm`; else the OTel kind; status from `status.code`; the OTLP span id kept as the `otel.span_id` attribute (Iris mints its own ids, as every door does) |

Tool spans feed the trajectory rules exactly as spans sent on `log_trace` do: `toSteps` reads the name from `gen_ai.tool.name`, `tool.name`, `tool_call.function.name`, `traceloop.entity.name` or `ai.toolCall.name` (else the span's name), the arguments from `gen_ai.tool.call.arguments`, `tool_call.function.arguments`, `input.value`, `traceloop.entity.input` or `ai.toolCall.args`, the result from their `output` twins, and the call id from `gen_ai.tool.call.id`, `tool_call.id` or `ai.toolCall.id`.

### The conventions, one fixture each

Every vocabulary above is held by a fixture in [`tests/fixtures/otlp/conventions/`](https://github.com/iris-eval/mcp-server/tree/main/tests/fixtures/otlp/conventions) — authored to the vendor's own documentation (the README there names the page every key came from) and read by `tests/unit/otel/conventions.test.ts`, which asserts the agent, the input, the output, the tokens, the model, the session, the tool steps and what the payload lacked. A recipe on the recipes page names the fixture that proves it.

| Framework | Fixture | What a buyer will test |
|---|---|---|
| Pydantic AI | `pydantic-ai.otlp.json` | `gen_ai.aggregated_usage.*` is the run's usage; the per-call `chat` usage is not added to it; cache-read tokens stay on the span |
| Google ADK | `google-adk.otlp.json` | `gen_ai.agent.name` names the agent when the resource has no `service.name`; `gen_ai.conversation.id` → `session_id`; `gen_ai.tool.definitions` → `tools[]` |
| LangGraph via LangSmith's OTel export | `langsmith.otlp.json` | `langsmith.span.kind` finds the `tool` and `llm` spans; content in `gen_ai.prompt` / `gen_ai.completion` |
| CrewAI via OpenInference | `crewai-openinference.otlp.json` | `input.value` / `output.value`, `llm.token_count.*`, `llm.model_name`, `session.id`, `openinference.span.kind` |
| OpenLLMetry (Traceloop) | `traceloop.otlp.json` | `traceloop.entity.input` / `output`, `traceloop.span.kind = tool`, indexed `gen_ai.prompt.N.content`, `llm.usage.total_tokens` |
| Microsoft Agent Framework | `agent-framework.otlp.json` | `invoke_agent` carrying the totals beside `chat` children that carry their own — counted once |
| Semantic Kernel | `semantic-kernel.otlp.json` | `gen_ai.response.prompt_tokens` / `completion_tokens`; content only in the `gen_ai.content.*` events |
| Vercel AI SDK (legacy `ai.*`) | `vercel-ai-sdk.otlp.json` | `ai.prompt`, `ai.response.text`, `ai.usage.*`, `ai.model.id`, `ai.toolCall.*`; the parent and its `doGenerate` child carry the same usage — counted once | A payload with no GenAI attributes at all is still stored — with what it carries — and the answer lists what it lacked, so you know why the rules that read an output did not run.

**Evaluation is off by default**: an OTLP feed is a firehose you did not necessarily mean to grade. `otel.evaluateOnIngest: true` in `config.json` scores each stored trace that carries an output, under exactly the rules `evaluate_output` runs; a trace without one answers `evaluation: null`.

The answer is OTLP's `ExportTraceServiceResponse` — `{}` when every span was accepted, `partialSuccess: { rejectedSpans, errorMessage }` when some carried no trace or span id — plus an `iris-eval` block:

```json
{ "iris-eval": { "count": 1, "evaluate_on_ingest": false,
  "stored": [{ "trace_id": "9f58…", "otel_trace_id": "5b8efff7…", "agent_name": "support-bot", "spans": 2, "steps": 1, "lacked": [] }] } }
```

A trace that arrived by OTLP is never re-exported to `IRIS_OTEL_ENDPOINT`, which may well be the collector that sent it.
