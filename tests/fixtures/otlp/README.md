# OTLP protobuf fixtures

Real request bodies, not hand-written: `opentelemetry-exporter-otlp-proto-http` 1.44.0 (with `opentelemetry-sdk` 1.44.0, `opentelemetry-proto` 1.44.0, `protobuf` 7.36.2) posted them to a capturing HTTP server on 2026-09-21, `compression=None`, one `BatchSpanProcessor` flush per fixture.

| File | What the SDK emitted |
|---|---|
| `python-genai.pb` | four spans in the GenAI conventions: an `invoke_agent` root carrying `gen_ai.agent.name`, `gen_ai.input.messages` and `gen_ai.output.messages`; two `chat` spans with `gen_ai.request.model` and `gen_ai.usage.*`; one `execute_tool` span with `gen_ai.tool.name`, `.call.id`, `.call.arguments`, `.call.result`; one event |
| `python-plain.pb` | one HTTP server span with nothing GenAI about it |

Each `.otlp.json` is the same message through protobuf's own JSON mapping (`google.protobuf.json_format.MessageToDict`, `use_integers_for_enums=True`) with `traceId`, `spanId` and `parentSpanId` hex-encoded as OTLP/JSON requires. The decoder test holds `src/otel/protobuf.ts` to reproducing that object exactly. The generator is the arc-9 record's `gen_otlp_fixtures.py`.
