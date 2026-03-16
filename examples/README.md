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

- [`langchain/observe-agent.py`](langchain/observe-agent.py) — Instrument a LangChain agent with Iris trace logging
- [`crewai/observe-crew.py`](crewai/observe-crew.py) — Instrument a CrewAI crew with Iris observability
