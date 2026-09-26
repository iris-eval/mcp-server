# OTLP protobuf fixtures

Real request bodies, not hand-written: `opentelemetry-exporter-otlp-proto-http` 1.44.0 (with `opentelemetry-sdk` 1.44.0, `opentelemetry-proto` 1.44.0, `protobuf` 7.36.2) posted them to a capturing HTTP server on 2026-09-21, `compression=None`, one `BatchSpanProcessor` flush per fixture.

| File | What the SDK emitted |
|---|---|
| `python-genai.pb` | four spans in the GenAI conventions: an `invoke_agent` root carrying `gen_ai.agent.name`, `gen_ai.input.messages` and `gen_ai.output.messages`; two `chat` spans with `gen_ai.request.model` and `gen_ai.usage.*`; one `execute_tool` span with `gen_ai.tool.name`, `.call.id`, `.call.arguments`, `.call.result`; one event |
| `python-plain.pb` | one HTTP server span with nothing GenAI about it |
| `langsmith-langgraph.pb` | LangSmith's own OpenTelemetry export (langsmith 0.14.1, opentelemetry-sdk and opentelemetry-exporter-otlp-proto-http 1.45.0, protobuf 7.36.2, recorded 2026-09-26) of a real LangGraph tool loop (langgraph 1.2.12, langchain-core 1.6.5, the scripted model in `packages/python/tests/langgraph_app.py`): nine spans, `gen_ai.prompt` / `gen_ai.completion` as bytes holding the graph's state as JSON |

Each `.otlp.json` is the same message through protobuf's own JSON mapping (`google.protobuf.json_format.MessageToDict`, `use_integers_for_enums=True`) with `traceId`, `spanId` and `parentSpanId` hex-encoded as OTLP/JSON requires. The decoder test holds `src/otel/protobuf.ts` to reproducing that object exactly. The generator script for the two `python-*` fixtures is not kept in this repository; `capture_langsmith.py` records `langsmith-langgraph.pb` and its twin.
