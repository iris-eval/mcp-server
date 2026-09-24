# OTLP fixtures, one per convention

The attribute vocabularies a user will point at `POST /v1/traces`. Each payload is OTLP/JSON,
**authored on 2026-09-21 to the vendor's own documentation or source** — the URL beside each file is where every
key came from; nothing here was captured from a running SDK (the two captured fixtures live one directory up). The
test `tests/unit/otel/conventions.test.ts` holds the door to reading each one: the agent, the input, the output, the
tokens, the model, the session, the tool steps and what the payload lacked.

The token arithmetic is chosen so the test can tell which rule the door applied: in `pydantic-ai` the leaf sum is
twenty tokens under the aggregate, so the aggregate is provably what wins; in `agent-framework` and `vercel-ai-sdk`
a parent carries the same usage as its children, so counting every span would double it.

| File | Framework and where the keys come from | What it exercises |
|---|---|---|
| `pydantic-ai.otlp.json` | Pydantic AI — https://pydantic.dev/docs/ai/integrations/logfire/ | `gen_ai.aggregated_usage.*` wins over the per-call sum; `gen_ai.usage.cache_read.input_tokens` stays on the span (informational); `execute_tool` with `gen_ai.tool.call.*` |
| `google-adk.otlp.json` | Google ADK — https://adk.dev/observability/traces/ | no `service.name` on the resource: `gen_ai.agent.name` names the agent, so nothing is lacked; `gen_ai.conversation.id` → `metadata.session_id`; `gen_ai.tool.definitions` → `tools[]`; `generate_content` as the LLM span |
| `langsmith.otlp.json` | LangGraph through LangSmith's OTel export — https://docs.langchain.com/langsmith/trace-with-opentelemetry | `langsmith.span.kind` names the run type (`tool`, `llm`); content in the deprecated `gen_ai.prompt` / `gen_ai.completion`; usage in `gen_ai.usage.input_tokens` |
| `crewai-openinference.otlp.json` | CrewAI through the OpenInference instrumentor — https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md | `openinference.span.kind`; `input.value` / `output.value` on the root; `llm.token_count.*`; `llm.model_name`; `session.id`; `tool.name` on the TOOL span |
| `traceloop.otlp.json` | OpenLLMetry — https://github.com/traceloop/openllmetry/blob/main/packages/opentelemetry-semantic-conventions-ai/opentelemetry/semconv_ai/__init__.py | `traceloop.entity.input` / `output` on the workflow; `traceloop.span.kind: tool` with `traceloop.entity.name`; `llm.request.type`; indexed `gen_ai.prompt.N.content`; `llm.usage.total_tokens` |
| `agent-framework.otlp.json` | Microsoft Agent Framework — https://learn.microsoft.com/en-us/agent-framework/user-guide/observability | `invoke_agent` carrying the run's totals beside `chat` children that carry their own: counted once |
| `semantic-kernel.otlp.json` | Semantic Kernel — https://learn.microsoft.com/en-us/semantic-kernel/concepts/enterprise-readiness/observability/telemetry-with-console?pivots=programming-language-python | `gen_ai.response.prompt_tokens` / `completion_tokens`; content only in the `gen_ai.content.prompt` / `completion` events; no tool span |
| `vercel-ai-sdk.otlp.json` | Vercel AI SDK, legacy `ai.*` spans — https://ai-sdk.dev/docs/ai-sdk-core/telemetry | `ai.prompt` / `ai.response.text` / `ai.usage.*` / `ai.model.id`; the parent and its `doGenerate` child carry the same usage: counted once; `ai.toolCall.*` as the tool step |

The recipes page (`docs/otel-recipes.md`) names the fixture that proves each recipe.
