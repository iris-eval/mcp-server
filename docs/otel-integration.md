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
| `agent_name` | resource `service.name`, unless it is the `unknown_service` / `unknown_service:<process>` every OTel SDK sets when none was named (0.20.0); `iris.agent_name`; `gen_ai.agent.name` on any span (ADK, Agent Framework, AutoGen, Pydantic AI) or OpenInference `agent.name` (the OpenAI Agents SDK's Python instrumentor); else `"otel"` (and the answer says it lacked `service.name`) |
| `input` | on the root span `iris.input`, then OpenInference's `llm.input_messages.*` read to the last user message, then `gen_ai.input.messages`, `gen_ai.prompt`, OpenInference `input.value`, Traceloop `traceloop.entity.input`, Vercel `ai.prompt`; then the first model call's `llm.input_messages.*` (0.20.0); then those keys on any span in start order; then Traceloop's indexed `gen_ai.prompt.N.content` joined in order; then a `gen_ai.content.prompt` event. A value that is a Python object's repr (`StopEvent(result=…)`, what a LlamaIndex workflow's own steps record) is passed over |
| `output` | the same for `iris.output`, `llm.output_messages.*` (the last assistant message with words), `gen_ai.output.messages`, `gen_ai.completion`, `output.value`, `traceloop.entity.output`, `ai.response.text`, indexed `gen_ai.completion.N.content`, `gen_ai.content.completion` — except that past the root span the spans are read latest end first (0.20.0): a run's output is what it ended with, and the OpenAI Agents SDK's Python instrumentor puts nothing on its root |
| `metadata.model` | `gen_ai.request.model`, `gen_ai.response.model`, OpenInference `llm.model_name`, `llm.request.model`, Vercel `ai.model.id` — what the judge's same-family check reads |
| `session_id` | resource or span `gen_ai.conversation.id`, `session.id` — the trace's session: the drawer shows the other turns, `GET /api/v1/traces?session=` lists them |
| `tools` | `gen_ai.tool.definitions` (a JSON list of `{ name, description, inputSchema \| parameters }`), else OpenInference's `llm.tools.N.tool.json_schema` (OpenAI's `{ type: "function", function: {...} }` or a flat tool, 0.20.0) — the catalogue `valid_tool_arguments` checks against |
| `token_usage` | `gen_ai.usage.input_tokens` / `output_tokens` (the older `prompt_tokens` / `completion_tokens`, `iris.*_tokens`, OpenInference `llm.token_count.prompt` / `completion`, Semantic Kernel `gen_ai.response.prompt_tokens` / `completion_tokens`, Vercel `ai.usage.promptTokens` / `completionTokens`) — summed over the LEAF carriers only, so a framework that puts the run's totals on `invoke_agent` beside `chat` children that carry their own is counted once; Pydantic AI's whole-run `gen_ai.aggregated_usage.*` is the answer when present |
| `cost_usd` | `iris.cost_usd`, `gen_ai.usage.cost`, `llm.usage.total_cost`, summed (`cost_source: "reported"`); when no span carries one, estimated from each model call's `gen_ai.usage.*_tokens` and its `gen_ai.response.model` / `gen_ai.request.model` at list price (`cost_source: "estimated"`, [cost.md](cost.md)) |
| `run`, `case_key` | `iris.run`, `iris.case_key` on the resource or the root span |
| `capture` | `iris.capture.name`, `iris.capture.version` and `iris.capture.complete` on the resource or the root span: the instrumentation declares itself and what it records in full (below) |
| `timestamp`, `latency_ms` | the root span's start, and its end minus start |
| `spans[]` | every span; kind `TOOL` when it carries `gen_ai.tool.*` / `tool.name` / `ai.toolCall.name`, `gen_ai.operation.name = execute_tool`, `openinference.span.kind = TOOL`, `langsmith.span.kind = tool` or `traceloop.span.kind = tool`; `INTERNAL` for an agent operation (`gen_ai.operation.name` `invoke_agent` or `create_agent`, since 0.20.0), even when it carries the model's name or the run's usage; `LLM` when it carries a GenAI request attribute (`gen_ai.request.model`, `llm.model_name`, `ai.model.id`, `llm.request.type` …), `openinference.span.kind = LLM` or `langsmith.span.kind = llm`; else the OTel kind; status from `status.code`; the OTLP span id kept as the `otel.span_id` attribute (Iris mints its own ids, as every door does) |

Two readings apply to every door (0.20.0). An attribute sent as bytes (`bytesValue`, which OTLP/JSON writes as base64) that holds UTF-8 text is read as that text; LangSmith's export sends `gen_ai.prompt` / `gen_ai.completion` that way. And an input or output that is a list of messages is read down to the last question asked and the last answer given: a message array (`gen_ai.input.messages` / `gen_ai.output.messages` in the conventions' `parts` schema, or OpenAI's `[{ role, content }]` as Semantic Kernel's content events carry it), or a LangChain envelope (a run's whole state as `{"messages": [...]}`, or a model result's `{"generations": ...}`). The trace's `input` and `output`, and so the rules and `GET /api/v1/traces?q=`, see the words; the span keeps the attribute exactly as sent. An array counts only when every element is a message with a role, and an answer that is only tool calls has no words and is kept as it came.

Tool spans feed the trajectory rules exactly as spans sent on `log_trace` do: `toSteps` reads the name from `gen_ai.tool.name`, `tool.name`, `tool_call.function.name`, `traceloop.entity.name` or `ai.toolCall.name` (else the span's name), the arguments from `gen_ai.tool.call.arguments`, `tool_call.function.arguments`, `input.value`, `traceloop.entity.input` or `ai.toolCall.args` (the three whose convention is a JSON string, `gen_ai.tool.call.arguments`, `tool_call.function.arguments` and `ai.toolCall.args`, are read as the object that string encodes, which is what a tool's input schema is checked against; so is OpenInference's `input.value` when the span's `input.mime_type` is `application/json`, and a Python call captured as `{"kwargs": {...}}` with no positional arguments, as the LlamaIndex instrumentor records a tool's input, is read as its keyword arguments, 0.20.0), the result from their `output` twins, and the call id from `gen_ai.tool.call.id`, `tool_call.id` or `ai.toolCall.id`.

### The conventions, one fixture each

The setup lines per framework — the vendor's own, with Iris as the endpoint — are on the [recipes page](otel-recipes.md), each recipe naming the fixture that proves it: one below, or a capture of the framework's real export (LangGraph via LangSmith, the OpenAI Agents SDK in Python and JavaScript, LlamaIndex) beside them in `tests/fixtures/otlp/`.

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

**A sender can ask for its own traces to be scored** (0.20.0): `iris.evaluate` set to `true` on the resource or the root span (the string `"true"` too, for an exporter that writes only strings) scores that trace with the config off, the per-trace twin of `evaluate: true` on `POST /api/v1/traces`. `iris.eval_type` names the bundle (`completeness`, `relevance`, `safety`, `cost`, `custom` or `all`; omitted, every bundle runs); an unknown one stores the trace unscored and says why in the entry's `evaluation_error`. The provider wrappers set it on every trace they send: `wrap_openai` / `wrap_anthropic` in the Python client and `wrapOpenAI` / `wrapAnthropic` / `irisMiddleware` in `@iris-eval/sdk` (not yet published to npm), each call one GenAI span — [packages/sdk/README.md](https://github.com/iris-eval/mcp-server/blob/main/packages/sdk/README.md).

**Instrumentation can say what it records in full** (0.20.0). Set `iris.capture.name` (and `iris.capture.version`) on the resource to say which software recorded the trace, and `iris.capture.complete` to the fields it records in full: a list, or one comma-separated string, from `input` and `tool_outputs`. Every verdict then names the instrumentation as the recorder, and a field declared and missing (no input read off any span, or a tool span with no result under `tool_outputs`) makes the verdict not checked, naming the instrumentation, so a capture that silently broke does not read as clean. Declare only what holds for every trace the instrumentation sends. A value Iris does not know, or a declaration without a name, is listed in the entry's `lacked` and ignored; the entry carries `capture` as read. See [the evidence contract](api-reference.md#the-evidence-contract-who-recorded-the-trace).

`tool_calls` is not taken over OTLP, and is listed in `lacked` when declared. A trace with no TOOL span says nothing on its own: one OTLP trace can arrive in several requests (a batching exporter sends the spans that have ended so far), Iris stores each request as its own trace, and a tool span in a vocabulary Iris does not read is not a TOOL span either. So "this request has no TOOL span" is not an observation that no tool was called, and a deployment that requires tool calls reads such a trace as not checked. To have an empty list read as "no tool was called", send the whole run in one call to `POST /api/v1/traces` or `iris-eval ingest` with `capture`.

The answer is OTLP's `ExportTraceServiceResponse` — `{}` when every span was accepted, `partialSuccess: { rejectedSpans, errorMessage }` when some carried no trace or span id — plus an `iris-eval` block:

```json
{ "iris-eval": { "count": 1, "evaluate_on_ingest": false,
  "stored": [{ "trace_id": "9f58…", "otel_trace_id": "5b8efff7…", "agent_name": "support-bot", "spans": 2, "steps": 1, "lacked": [] }] } }
```

With a relevance judge installed (`IRIS_RELEVANCE_JUDGE_MODEL`), one request makes at most `IRIS_RELEVANCE_JUDGE_MAX_CALLS_PER_REQUEST` judge calls (default 20), and the block carries `relevance_judge: { calls, withheld, max_calls_per_request }`; a trace past the cap is scored with the lexical reading and its `answers_the_ask` result says so in `judge.withheld`. See [the relevance judge](https://github.com/iris-eval/mcp-server/blob/main/docs/llm-as-judge.md#the-relevance-judge-behind-answers_the_ask) for what it sends and what it may spend.

A trace that arrived by OTLP is never re-exported to `IRIS_OTEL_ENDPOINT`, which may well be the collector that sent it.

**How fast it takes traces in.** One Iris process stores traces through one SQLite writer, and each request's traces go into the full-text search index in the same transaction. On a Windows 11 desktop (Node 24.11, better-sqlite3), sustained OTLP ingest of traces with two model spans each, in requests of 100, stored 1,700 to 2,000 traces/s into a store of 100,000 traces and about 2,000 into one of 10,000, over two five-round runs (0.19.0, which had no index: 2,300 to 2,400 and 2,600 to 2,700). With `storage.searchIndex` set to `off` (`IRIS_SEARCH_INDEX=off`) nothing is indexed, and the same feed stored about 4,200 and 4,400 traces/s. The price is search: `GET /api/v1/traces?q=` then reads the traces themselves within `storage.searchBudgetMs`, newest first. A word in one trace in a hundred took about 180 ms at 10,000 traces and found all 100 matches, against 4 ms with the index. At 100,000 traces it took about 1.7 s, stopped at the default 1,000 ms budget and answered with 527 to 584 of the 1,000 matches (`search.complete: false`), against 7 ms and all of them with the index. A search runs on its own thread either way, so it does not hold other requests. For a feed faster than that, run a Collector in front with batching and a queue; it smooths bursts, but a sustained rate above the store's stays above it.
