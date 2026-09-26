# Iris Examples

## Claude Desktop

Configure Iris as an MCP server in Claude Desktop for automatic agent observability.

- [`claude-desktop/mcp-config.json`](claude-desktop/mcp-config.json) — MCP configuration
- [`claude-desktop/README.md`](claude-desktop/README.md) — Step-by-step setup guide

## TypeScript

- [`typescript/basic-usage.ts`](typescript/basic-usage.ts) — Connect to Iris via MCP SDK, log traces, evaluate outputs, query results

## HTTP Transport

Use Iris over HTTP for multi-client access, REST integrations, and frontend dashboards.

- [`http-transport/README.md`](http-transport/README.md) — Full guide: starting in HTTP mode, authentication, curl/fetch/Python examples, CORS config
- [`http-transport/client.ts`](http-transport/client.ts) — TypeScript: log traces, evaluate, query dashboard API over HTTP
- [`http-transport/client.py`](http-transport/client.py) — Python: same workflow using `requests`

## Python

Complete programs: each needs a model key and a running Iris, and lists its installs.

- [`langchain/observe-agent.py`](langchain/observe-agent.py) — a LangGraph agent with `IrisCallbackHandler` in its callbacks: each run arrives as one trace with its tool calls and a verdict. CI runs the same graph with a scripted model (`packages/python/tests/test_langchain_e2e.py`). The handler ships in the Python client's next release; the file shows the install from this repository until then. The JavaScript handler is [`packages/langchain`](../packages/langchain/README.md) (`@iris-eval/langchain`, not yet published to npm).
- [`crewai/observe-crew.py`](crewai/observe-crew.py) — a crew traced by the OpenInference instrumentor straight to Iris's OTLP door, the [CrewAI recipe](../docs/otel-recipes.md#crewai-via-openinference) as a script.
