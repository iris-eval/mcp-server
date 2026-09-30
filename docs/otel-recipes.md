# OTel recipes — one per framework, each proved by a fixture

Iris reads the OpenTelemetry traces your framework already emits. Point its exporter at `POST /v1/traces` on the dashboard port — JSON or protobuf, so the Python exporter reaches it without a Collector — and each OTLP trace becomes an Iris trace with its spans, read through the vocabulary the framework speaks ([the mapping](otel-integration.md#traces-arrive-by-otlp)).

Every recipe below is the vendor's own setup lines, read from the page it links on 2026-09-21 (the OpenAI Agents SDK and LlamaIndex recipes on 2026-09-28), with Iris as the endpoint; then what Iris reads out of that vocabulary; then **the fixture in this repository that proves the reading** — an OTLP payload authored to the vendor's documentation and held by `tests/unit/otel/conventions.test.ts`, a payload captured from the Python SDK, or a payload captured from the framework itself running the recipe (held by `tests/unit/otel/recipe-captures.test.ts` and `langsmith-capture.test.ts`). A recipe that named no fixture would be a claim. Where the fixture proves the vocabulary and not the framework's own capture, the recipe says so.

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
| [OpenAI Agents SDK (Python)](#openai-agents-sdk-python) | `openai-agents.otlp.json` (captured, and run in CI) |
| [OpenAI Agents SDK (JavaScript)](#openai-agents-sdk-javascript) | `openai-agents-js.otlp.json` (captured, and run in CI) |
| [LlamaIndex](#llamaindex) | `llamaindex.otlp.json` (captured, and run in CI) |
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

### OpenAI Agents SDK (Python)

Proved by: `tests/fixtures/otlp/openai-agents.otlp.json`

The Agents SDK traces every run through its own trace processors, which upload to the OpenAI dashboard. OpenInference's instrumentor replaces them with one that emits OpenTelemetry spans, so no trace goes to OpenAI (`instrument(tracer_provider=provider, exclusive_processor=False)` keeps both).

```bash
pip install openai-agents openinference-instrumentation-openai-agents opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:6920
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20<key>"   # on a keyed server
export OTEL_SERVICE_NAME=weather-agent                              # the agent name
```

```python
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from openinference.instrumentation.openai_agents import OpenAIAgentsInstrumentor

provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))   # reads OTEL_EXPORTER_OTLP_*
OpenAIAgentsInstrumentor().instrument(tracer_provider=provider)
```

A session is OpenInference's, not the SDK's: the `group_id` in a `RunConfig` does not reach the spans.

```python
from openinference.instrumentation import using_session

with using_session("session-paris-1"):
    result = Runner.run_sync(agent, question)
```

What Iris reads: the input from the first model call's last user message (`llm.input_messages.*`) and the output from the answer of the call that ended last (`llm.output_messages.*`), because this instrumentor puts neither on the run's root span; the usage as the sum of `llm.token_count.*` over the model calls; the model from `llm.model_name`; the agent from `service.name`, else the `Agent`'s own name from `agent.name`; the session from `session.id`; the tool steps from `openinference.span.kind = TOOL` spans with `tool.name`, their arguments from `input.value`; the tools offered to the model from `llm.tools.N.tool.json_schema`, which `valid_tool_arguments` checks each call against.

The cost: the spans carry none, so Iris estimates it from the token counts and the model's list price and stores it with `cost_source: "estimated"` and the prices it used in `cost_estimate` (the captured run: 50 input and 20 output tokens of `gpt-4o-mini`, $0.0000195).

What it does not carry: the call id on a tool span, so a step is not linked to the model request that asked for it; the agent's instructions, which the SDK sends outside the messages.

The fixture is a capture of this recipe's export for a real tool-calling run (`tests/fixtures/otlp/capture_recipe.py openai-agents` records it, with the versions pinned in `examples/otel-recipes/requirements-openai-agents.txt`). CI runs the recipe itself: `tests/otel-recipes/test_recipes_e2e.py` exports a run to a real Iris server and requires the trace with its words, its tool call, its usage, its session and a verdict, and a leaked SSN failed by `no_pii`.

Source: https://openai.github.io/openai-agents-python/tracing/ · https://github.com/Arize-ai/openinference/tree/main/python/instrumentation/openinference-instrumentation-openai-agents

### OpenAI Agents SDK (JavaScript)

Proved by: `tests/fixtures/otlp/openai-agents-js.otlp.json`

The same route for `@openai/agents`: OpenInference's JavaScript instrumentation registers through the SDK's trace-processor API and, by default, replaces the processor that uploads to OpenAI.

```bash
npm install @openai/agents zod @arizeai/openinference-instrumentation-openai-agents @opentelemetry/sdk-trace-node @opentelemetry/sdk-trace-base @opentelemetry/resources @opentelemetry/exporter-trace-otlp-proto
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:6920
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20<key>"   # on a keyed server
```

```ts
import * as agents from '@openai/agents';
import { OpenAIAgentsInstrumentation } from '@arizeai/openinference-instrumentation-openai-agents';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ 'service.name': 'weather-agent' }),
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],   // reads OTEL_EXPORTER_OTLP_*
});
provider.register();
new OpenAIAgentsInstrumentation({ tracerProvider: provider }).manuallyInstrument(agents);
```

A session, with `@arizeai/openinference-core` and `@opentelemetry/api`:

```ts
import { context } from '@opentelemetry/api';
import { setSession } from '@arizeai/openinference-core';

const result = await context.with(setSession(context.active(), { sessionId: 'session-paris-1' }), () => agents.run(agent, question));
```

What Iris reads: the input and output from the root span's `input.value` / `output.value`, where this instrumentor writes the run's input and its final answer; the usage, the estimated cost, the model, the session, the tool steps and the offered tools as in the Python recipe. The agent comes from `service.name` alone: this instrumentor names the agent in `graph.node.id`, not `agent.name`, so a provider with no service name stores the trace under `"otel"` and the answer says it lacked `service.name`. The resource above is where the name is set.

The fixture is a capture of this recipe's export (`tests/fixtures/otlp/capture_recipe.py openai-agents-js`, with the versions pinned in `examples/otel-recipes/js/package.json`), and CI runs the recipe against a real Iris server in the same test as the Python one.

Source: https://openai.github.io/openai-agents-js/guides/tracing/ · https://github.com/Arize-ai/openinference/tree/main/js/packages/openinference-instrumentation-openai-agents

### LlamaIndex

Proved by: `tests/fixtures/otlp/llamaindex.otlp.json`

OpenInference's LlamaIndex instrumentor traces agents, workflows, query engines and every LLM call as OpenTelemetry spans.

```bash
pip install llama-index-core llama-index-llms-openai openinference-instrumentation-llama-index opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:6920
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20<key>"   # on a keyed server
export OTEL_SERVICE_NAME=weather-agent                              # the agent name
```

```python
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from openinference.instrumentation.llama_index import LlamaIndexInstrumentor

provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))   # reads OTEL_EXPORTER_OTLP_*
LlamaIndexInstrumentor().instrument(tracer_provider=provider)
```

`FunctionAgent` streams its model calls, and OpenAI sends a streamed call's token usage only when asked; without `stream_options` the trace has no usage. The session is OpenInference's:

```python
from openinference.instrumentation import using_session

agent = FunctionAgent(
    llm=OpenAI(model="gpt-4o-mini", additional_kwargs={"stream_options": {"include_usage": True}}),
    tools=[get_weather],
)
with using_session("session-paris-1"):
    response = await agent.run(user_msg=question)
```

What Iris reads: the input from the first model call's last user message (`llm.input_messages.*`) and the output from the answer of the call that ended last (`llm.output_messages.*`). A workflow's own steps record their events as Python reprs (`StopEvent(result=AgentOutput(…))`, cut off at 200 characters), the root's output among them; Iris passes a repr over rather than judge a class name. The usage from `llm.token_count.*`; the model from `llm.model_name`; the session from `session.id`; the tool steps from `FunctionTool.acall` spans with `tool.name`, whose `input.value` is the Python call (`{"kwargs": {"city": "Paris"}}`) and is read as its keyword arguments; the tools offered to the model from `llm.tools.N.tool.json_schema`. The cost is estimated from the tokens and the model, as in the OpenAI Agents SDK recipe; without `stream_options` there are no tokens, so there is no cost either. The agent comes from `service.name` alone: nothing on the spans names it, so without `OTEL_SERVICE_NAME` the trace is stored under `"otel"` and the answer says it lacked `service.name`.

LlamaIndex's observability page names its own `llama-index-observability-otel` package for OpenTelemetry. In a capture of the same run (0.7.0) its spans carried each step's input as a truncated Python repr and no model name, messages or token counts: Iris stores those spans with no input, output or usage, and the answer lists what they lacked. Use the OpenInference instrumentor.

The fixture is a capture of this recipe's export (`tests/fixtures/otlp/capture_recipe.py llamaindex`, with the versions pinned in `examples/otel-recipes/requirements-llamaindex.txt`), and CI runs the recipe against a real Iris server in the same test.

Source: https://developers.llamaindex.ai/python/framework/module_guides/observability/ · https://github.com/Arize-ai/openinference/tree/main/python/instrumentation/openinference-instrumentation-llama-index

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
