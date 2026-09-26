# OTel recipes — one per framework, each proved by a fixture

Iris reads the OpenTelemetry traces your framework already emits. Point its exporter at `POST /v1/traces` on the dashboard port — JSON or protobuf, so the Python exporter reaches it without a Collector — and each OTLP trace becomes an Iris trace with its spans, read through the vocabulary the framework speaks ([the mapping](otel-integration.md#traces-arrive-by-otlp)).

Every recipe below is the vendor's own setup lines, read from the page it links on 2026-09-21, with Iris as the endpoint; then what Iris reads out of that vocabulary; then **the fixture in this repository that proves the reading** — an OTLP payload authored to the vendor's documentation and held by `tests/unit/otel/conventions.test.ts`, or a payload captured from the Python SDK. A recipe that named no fixture would be a claim. Where the fixture proves the vocabulary and not the framework's own capture, the recipe says so.

## The lines every recipe shares

| What | Line |
|---|---|
| The endpoint, when the SDK appends `/v1/traces` itself | `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:6920` |
| The endpoint, in full | `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:6920/v1/traces`, or `endpoint="http://127.0.0.1:6920/v1/traces"` in code |
| The key, on a server that has one | `OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20<key>"` (values percent-encoded, as the OTel specification reads them), or `headers={"Authorization": "Bearer <key>"}` in code |
| Scoring | `otel.evaluateOnIngest: true` in `config.json` — off by default; an OTLP feed is a firehose you did not necessarily mean to grade |
| The answer | OTLP's own `ExportTraceServiceResponse` plus an `iris-eval` block naming each stored trace, its agent, its span and step counts, and what the payload lacked |

Calling OpenAI or Anthropic directly, with no framework? The provider wrappers record each call as one GenAI span to this same door and ask for its verdict: `wrap_openai` / `wrap_anthropic` in the Python client, `wrapOpenAI` / `wrapAnthropic` and the Vercel AI SDK's `irisMiddleware` in `@iris-eval/sdk` (not yet published to npm) — [packages/sdk/README.md](https://github.com/iris-eval/mcp-server/blob/main/packages/sdk/README.md), [packages/python/README.md](https://github.com/iris-eval/mcp-server/blob/main/packages/python/README.md).

The Python OTLP/HTTP exporter is protobuf-only; Iris takes `application/x-protobuf` since 0.16.0, so none of the Python recipes needs a Collector. A Collector still works — `otlphttp` exporter, `endpoint: http://127.0.0.1:6920` — when one is already in the path.

## The recipes

| Framework | Proved by |
|---|---|
| [Pydantic AI](#pydantic-ai) | `pydantic-ai.otlp.json` |
| [Google ADK](#google-adk) | `google-adk.otlp.json` |
| [LangGraph via LangSmith's export](#langgraph-via-langsmiths-export) | `langsmith-langgraph.otlp.json` (captured) |
| [CrewAI via OpenInference](#crewai-via-openinference) | `crewai-openinference.otlp.json` |
| [AutoGen](#autogen) | `python-genai.otlp.json` (the vocabulary) |
| [Microsoft Agent Framework](#microsoft-agent-framework) | `agent-framework.otlp.json` |
| [Semantic Kernel](#semantic-kernel) | `semantic-kernel.otlp.json` |
| [Vercel AI SDK](#vercel-ai-sdk) | `vercel-ai-sdk.otlp.json` |
| [Mastra](#mastra) | `python-genai.otlp.json` (the vocabulary) |

OpenLLMetry (Traceloop) is not a framework but a vocabulary several teams already emit; `traceloop.otlp.json` proves it, and any framework instrumented by OpenLLMetry reaches Iris through the same lines as [CrewAI via OpenInference](#crewai-via-openinference) with the Traceloop instrumentor in place of the OpenInference one.

### Pydantic AI

Proved by: `tests/fixtures/otlp/conventions/pydantic-ai.otlp.json`

Pydantic AI follows the OpenTelemetry semantic conventions for generative AI and instruments every agent with one call.

```bash
pip install pydantic-ai opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:6920
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20<key>"   # on a keyed server
```

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from pydantic_ai import Agent

provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))   # reads OTEL_EXPORTER_OTLP_ENDPOINT
trace.set_tracer_provider(provider)
Agent.instrument_all()
```

What Iris reads: the run's usage from `gen_ai.aggregated_usage.*` — the per-call `chat` usage is not added to it, and cache-read tokens stay on the span; the agent from `gen_ai.agent.name`; the model from `gen_ai.request.model`; the messages when the instrumentation includes content; the tool calls from `execute_tool` spans.

Source: https://pydantic.dev/docs/ai/integrations/logfire/

### Google ADK

Proved by: `tests/fixtures/otlp/conventions/google-adk.otlp.json`

ADK implements the OpenTelemetry semantic conventions for GenAI — `invoke_agent`, `execute_tool`, `generate_content` — and exports wherever the standard variables point.

```bash
pip install google-adk opentelemetry-exporter-otlp-proto-http
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:6920/v1/traces
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20<key>"           # on a keyed server
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=EVENT_ONLY       # content, opt-in
export ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=true
```

What Iris reads: the agent from `gen_ai.agent.name` when the resource carries no `service.name` (nothing is lacked); the session from `gen_ai.conversation.id`; the tool catalogue from `gen_ai.tool.definitions`, which `valid_tool_arguments` checks against; the tool steps from `execute_tool` spans with `gen_ai.tool.call.id`.

Source: https://adk.dev/observability/traces/ · https://docs.cloud.google.com/stackdriver/docs/instrumentation/ai-agent-adk

### LangGraph via LangSmith's export

Proved by: `tests/fixtures/otlp/langsmith-langgraph.otlp.json`

LangChain and LangGraph trace through LangSmith's SDK, which can emit OpenTelemetry instead of, or beside, its own service. Two of its settings differ from the lines every other recipe shares, and the end-to-end test found both: LangSmith posts to `OTEL_EXPORTER_OTLP_ENDPOINT` exactly as written, so the path `/v1/traces` goes in it, and it passes `OTEL_EXPORTER_OTLP_HEADERS` through without percent-decoding, so the space after `Bearer` is a plain space.

```bash
pip install "langsmith[otel]" opentelemetry-exporter-otlp-proto-http
export LANGSMITH_TRACING=true
export LANGSMITH_OTEL_ENABLED=true
export LANGSMITH_OTEL_ONLY=true                       # SDK 0.4.1 or later: OTel only, nothing to LangSmith
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:6920/v1/traces
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <key>"      # on a keyed server; not percent-encoded
export OTEL_SERVICE_NAME=support-graph                # the agent name; LangSmith's default is "langsmith"
```

LangSmith batches spans in the background: a short script flushes before it exits (`langsmith.run_trees.get_cached_client().flush()`, then `opentelemetry.trace.get_tracer_provider().force_flush()`). Its resource carries the service name and a marker of its own, so a verdict on these traces comes from `otel.evaluateOnIngest: true` on the server.

What Iris reads: LangSmith sends `gen_ai.prompt` / `gen_ai.completion` as bytes holding the run's whole state as JSON (`{"messages": [...]}` for a graph, `{"generations": ...}` for a model call); Iris decodes the bytes and reads that state down to the last question asked and the last answer given. `langsmith.span.kind` finds the `tool` and `llm` spans, `gen_ai.tool.name` and `gen_ai.tool.call.id` name the tool step, the usage is the sum of the model calls' `gen_ai.usage.*`, and the model comes from `gen_ai.request.model`. The fixture is a capture of this export for a real LangGraph tool loop (`tests/fixtures/otlp/capture_langsmith.py` records it); `langsmith.otlp.json` beside the other conventions is the vocabulary as LangSmith's page describes it. CI runs the recipe itself: `packages/python/tests/test_langsmith_otel_e2e.py` sets these variables, runs the graph, and requires the trace in Iris with its words, its tool call, its token usage and a verdict.

Without LangSmith: `IrisCallbackHandler` sends the same run straight to this door with a verdict asked for, in Python (`from iris_eval.langchain import IrisCallbackHandler`) and in JavaScript (`@iris-eval/langchain`, not yet published to npm) — [packages/python/README.md](https://github.com/iris-eval/mcp-server/blob/main/packages/python/README.md#langchain-and-langgraph), [packages/langchain/README.md](https://github.com/iris-eval/mcp-server/blob/main/packages/langchain/README.md).

Source: https://docs.langchain.com/langsmith/trace-with-opentelemetry

### CrewAI via OpenInference

Proved by: `tests/fixtures/otlp/conventions/crewai-openinference.otlp.json`

CrewAI's own `tracing=True` uploads to CrewAI's platform, not to an OTLP endpoint; the OpenInference instrumentor is how a crew reaches any OTel backend.

```bash
pip install crewai openinference-instrumentation-crewai opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
```

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from openinference.instrumentation.crewai import CrewAIInstrumentor

provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(
    endpoint="http://127.0.0.1:6920/v1/traces",
    headers={"Authorization": "Bearer <key>"},     # on a keyed server
)))
trace.set_tracer_provider(provider)
CrewAIInstrumentor().instrument(tracer_provider=provider)
```

What Iris reads: the input and output from `input.value` / `output.value`; the usage from `llm.token_count.*`; the model from `llm.model_name`; the session from `session.id`; the tool steps from `openinference.span.kind = TOOL` with `tool.name`.

Source: https://docs.crewai.com/en/observability/tracing · https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md

### AutoGen

Proved by: `tests/fixtures/otlp/python-genai.otlp.json`

AutoGen's runtime emits `create_agent`, `invoke_agent` and `execute_tool` spans in the GenAI semantic conventions through whatever tracer provider it is handed.

```bash
pip install autogen-core opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
```

```python
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from autogen_core import SingleThreadedAgentRuntime

tracer_provider = TracerProvider(resource=Resource({"service.name": "support-bot"}))
tracer_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(
    endpoint="http://127.0.0.1:6920/v1/traces",
    headers={"Authorization": "Bearer <key>"},     # on a keyed server
)))
runtime = SingleThreadedAgentRuntime(tracer_provider=tracer_provider)
```

What Iris reads: the agent from `service.name`, else `gen_ai.agent.name`; the tool steps from `execute_tool` spans with `gen_ai.tool.name`. AutoGen's runtime spans carry `gen_ai.operation.name`, `gen_ai.system`, the agent and tool names and descriptions — **not the messages and not the token counts**; a trace gets an input, an output and usage only from spans your own code adds (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.usage.*`, or Iris's `iris.input` / `iris.output`). `AUTOGEN_DISABLE_RUNTIME_TRACING=true` turns the runtime's spans off.

The fixture is a capture of the Python SDK emitting these conventions (`invoke_agent` root with `gen_ai.agent.name`, `execute_tool` children); it proves the vocabulary AutoGen states, not a payload captured from AutoGen itself, which is not in the set.

Source: https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/telemetry.html

### Microsoft Agent Framework

Proved by: `tests/fixtures/otlp/conventions/agent-framework.otlp.json`

The Agent Framework emits traces, logs and metrics according to the OpenTelemetry GenAI semantic conventions — `invoke_agent`, `chat`, `execute_tool` — and configures its providers from the standard variables.

```bash
pip install agent-framework
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:6920
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20<key>"   # on a keyed server
export ENABLE_SENSITIVE_DATA=true                                   # the messages, opt-in
```

```python
from agent_framework.observability import configure_otel_providers

configure_otel_providers()   # or configure_otel_providers(otlp_endpoint="http://127.0.0.1:6920", otlp_protocol="http/protobuf")
```

What Iris reads: the run's usage once — `invoke_agent` carries the totals beside `chat` children that carry their own, and a leaf-carrier sum would double them; the agent from `gen_ai.agent.name`; the messages with `ENABLE_SENSITIVE_DATA`.

Source: https://learn.microsoft.com/en-us/agent-framework/user-guide/observability

### Semantic Kernel

Proved by: `tests/fixtures/otlp/conventions/semantic-kernel.otlp.json`

Semantic Kernel's GenAI telemetry is gated behind two variables; with them set, any tracer provider with an OTLP exporter carries it.

```bash
pip install semantic-kernel opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
export SEMANTICKERNEL_EXPERIMENTAL_GENAI_ENABLE_OTEL_DIAGNOSTICS=true
export SEMANTICKERNEL_EXPERIMENTAL_GENAI_ENABLE_OTEL_DIAGNOSTICS_SENSITIVE=true   # the content, opt-in
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:6920
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20<key>"                  # on a keyed server
```

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)
```

What Iris reads: the usage from `gen_ai.response.prompt_tokens` / `gen_ai.response.completion_tokens`; the content only from the `gen_ai.content.prompt` / `gen_ai.content.completion` events, which the sensitive flag turns on; the model from `gen_ai.request.model`.

Source: https://learn.microsoft.com/en-us/semantic-kernel/concepts/enterprise-readiness/observability/

### Vercel AI SDK

Proved by: `tests/fixtures/otlp/conventions/vercel-ai-sdk.otlp.json`

The AI SDK records a span per call when telemetry is enabled on it, through whatever tracer the app registers — legacy `ai.*` spans, and the GenAI-convention `invoke_agent` / `chat` / `execute_tool` spans on current versions.

```bash
npm install ai @ai-sdk/otel @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http
```

```ts
// instrumentation.ts — once, at startup
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerTelemetry } from 'ai';
import { OpenTelemetry } from '@ai-sdk/otel';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: 'http://127.0.0.1:6920/v1/traces',
    headers: { Authorization: 'Bearer <key>' },   // on a keyed server
  }),
});
sdk.start();
registerTelemetry(new OpenTelemetry());
```

```ts
// each call
const result = await generateText({
  model,
  prompt,
  experimental_telemetry: { isEnabled: true, functionId: 'support-answer' },
});
```

What Iris reads: the prompt and the answer from `ai.prompt` / `ai.response.text`; the usage from `ai.usage.*` — the parent and its `doGenerate` child carry the same numbers and are counted once; the model from `ai.model.id`; the tool steps from `ai.toolCall.*`. The GenAI-convention spans (`gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.input.messages`, `gen_ai.tool.name`) are read as any GenAI payload is. `recordInputs: false` / `recordOutputs: false` keep the content off the wire; Iris then stores the trace with no input or output and evaluates nothing.

Source: https://ai-sdk.dev/docs/ai-sdk-core/telemetry

### Mastra

Proved by: `tests/fixtures/otlp/python-genai.otlp.json`

Mastra follows the OpenTelemetry semantic conventions for GenAI — `invoke_agent {agent_id}`, `chat {model}`, `execute_tool {tool_name}` — and ships an OTLP exporter with a custom-endpoint form.

```bash
npm install @mastra/otel-exporter @opentelemetry/exporter-trace-otlp-http   # http/json; the proto package for http/protobuf
```

```ts
import { OtelExporter } from '@mastra/otel-exporter';

const exporter = new OtelExporter({
  provider: {
    custom: {
      endpoint: 'http://127.0.0.1:6920/v1/traces',
      protocol: 'http/json',                          // or 'http/protobuf'
      headers: { Authorization: 'Bearer <key>' },     // on a keyed server
    },
  },
});
// then: exporters: [exporter] in the observability config of new Mastra({ … }), as the page shows
```

What Iris reads: the agent from `gen_ai.agent.name` on the `invoke_agent` span; the model from `gen_ai.request.model`; the usage from `gen_ai.usage.input_tokens` / `output_tokens`; the tool steps from `execute_tool` spans; the messages when Mastra puts them on the span. `mastra.tags` and Mastra's own attributes ride along in the span's attributes.

The fixture is a capture of the Python SDK emitting the GenAI conventions Mastra states it follows; it proves the vocabulary, not a payload captured from Mastra itself, which is not in the set.

Source: https://mastra.ai/docs/observability/tracing/exporters/otel

## Reading what arrived

`GET /api/v1/traces?framework=` does not know these frameworks apart — the door records `source: "otel"` and whatever `service.name` the resource carried. The `iris-eval` block in the OTLP answer says, per trace, what was read and what was lacked; `GET /api/v1/traces/:id` shows the spans, and the trace drawer shows the steps the trajectory rules judged. A trace that arrived with no output is stored and not evaluated: the recipe's content flag is what makes it judgeable.
