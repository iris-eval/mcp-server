# @iris-eval/langchain

> **Not yet published to npm.** `@iris-eval/langchain` and the recorder it builds on, `@iris-eval/sdk`, are built and proven in this repository's CI, but `npm install @iris-eval/langchain` does not resolve yet. To use it today, build both from source and install them by path:
>
> ```bash
> git clone https://github.com/iris-eval/mcp-server && cd mcp-server/packages/sdk && npm ci && npm run build
> cd ../langchain && npm ci && npm run build
> cd /path/to/your-project && npm install /path/to/mcp-server/packages/sdk /path/to/mcp-server/packages/langchain
> ```

A LangChain.js and LangGraph.js callback handler that sends each run to [Iris](https://iris-eval.com) and gets its verdict, without the agent having to call an Iris tool.

```ts
import { IrisCallbackHandler } from '@iris-eval/langchain';

const iris = new IrisCallbackHandler({ agentName: 'support-bot' });
await graph.invoke({ messages: [new HumanMessage('What is the weather in Paris?')] }, { callbacks: [iris] });
```

Each top-level run (a graph, a chain, an agent, or a model called on its own) becomes one trace. The run is the root span; each model call, tool call, graph node, chain step and retriever inside it is a child span, in the OpenTelemetry GenAI conventions (`invoke_agent`, `chat`, `execute_tool`). When the top-level run ends the trace goes to Iris's OTLP ingest, `POST /v1/traces`, with a verdict asked for, so Iris stores it with:

| What | From |
|---|---|
| Input and output | the last user message the run was given and the last assistant message it produced (or its `input` / `output` field, or the value itself) |
| Tool calls | each tool's name, call id, arguments and result, as `execute_tool` spans; Iris's trajectory rules read them as steps |
| Token usage | every model call's `usage_metadata`, summed by Iris over the calls |
| Latency | the run's start to its end |
| The model and the tool catalogue | the model's `ls_model_name` / invocation parameters and the tools bound to it |
| Session | `sessionId`, or a LangGraph `thread_id`, as `gen_ai.conversation.id` |

A run that throws still arrives, with its error on the span that raised and on the root, and is not scored: it has no answer to judge. The handler never throws into the run and never makes it wait; delivery happens in the background, and Iris being down loses the trace, never the run.

## Options

| Option | Default |
|---|---|
| `recorder` | the process-wide `IrisRecorder` from `@iris-eval/sdk`, which finds Iris from `IRIS_URL` or the `runtime.json` a running server wrote, and reads `IRIS_API_KEY` |
| `agentName` | the running program's name |
| `sessionId` | the run's LangGraph `thread_id`, if it has one |
| `run` | none; sets `iris.run`, for comparing runs |
| `evaluate`, `evalType` | `true`, every bundle |

`@iris-eval/sdk` is a peer dependency, so an application that also wraps its OpenAI or Anthropic client with `wrapOpenAI` / `wrapAnthropic` shares one recorder with the handler. `@langchain/core` is a peer too. No other dependencies. ESM and CommonJS, Node 22 or later.

## Already exporting OpenTelemetry through LangSmith?

Point that export at Iris instead: the recipe is in [docs/otel-recipes.md](https://github.com/iris-eval/mcp-server/blob/main/docs/otel-recipes.md#langgraph-via-langsmiths-export), run for real in CI with LangSmith's Python SDK.

## Proven

CI (`langchain-js` in `.github/workflows/ci.yml`, Node 22 and 24) runs a real LangGraph.js app, the canonical tool loop (a model node, LangGraph's `ToolNode` and `toolsCondition`) with a scripted chat model, under `@langchain/core` 1.2.12 and `@langchain/langgraph` 1.4.18. Each run must arrive in a real Iris server built from the same commit as one trace with its input, output, tool call, token usage and a verdict; an answer carrying an SSN must be failed; a failing tool must arrive as an error; a `thread_id` must become the session; a plain chain and a bare model call must arrive too. The same job packs the package with `@iris-eval/sdk`, installs both into an empty project and loads the handler by `import` and by `require`. The Python client's `iris_eval.langchain.IrisCallbackHandler` runs the same cases against a LangGraph app in `python-client`.

## License

MIT
