# @iris-eval/langchain

> **Not yet published to npm.** `@iris-eval/langchain` lives in this repository and is built in CI, but it is not on the npm registry, so `npm install @iris-eval/langchain` does not resolve yet. To use it today, build from source and install it by path:
>
> ```bash
> git clone https://github.com/iris-eval/mcp-server && cd mcp-server/packages/langchain
> npm ci && npm run build
> cd /path/to/your-project && npm install /path/to/mcp-server/packages/langchain
> ```
>
> Whether this package is published or retired is an open decision; this note is removed with the first publish.

Evaluate LangChain agent output with [Iris](https://iris-eval.com) — stop shipping agents on vibes. Auto-trace runs, score output quality, catch safety failures.

## Install

Once published:

```bash
npm install @iris-eval/langchain
```

## Usage

```typescript
import { IrisCallbackHandler } from '@iris-eval/langchain';

const iris = new IrisCallbackHandler({
  serverUrl: 'http://localhost:3000', // default Iris HTTP transport port; or use MCP stdio
});

// Add to any LangChain chain or agent
const result = await chain.invoke(
  { input: "What is the capital of France?" },
  { callbacks: [iris] }
);

// Iris automatically logs:
// - Full execution trace with spans
// - Token usage and cost per step
// - Tool calls with input/output
// - Latency per chain step
```

## What gets traced

| Event | Captured |
|-------|----------|
| Chain start/end | Agent name, input, output, latency |
| LLM calls | Model, tokens, cost, response |
| Tool calls | Tool name, input, output, duration |
| Retriever calls | Query, documents returned, latency |
| Errors | Exception type, message, stack trace |

## How it works

`IrisCallbackHandler` implements LangChain's `BaseCallbackHandler` interface. It captures events from your chain execution and sends them to Iris as structured traces via the MCP protocol.

No changes to your chain code. Just add the callback.

## Links

- [Iris GitHub](https://github.com/iris-eval/mcp-server)
- [Iris Website](https://iris-eval.com)
- [Documentation](https://github.com/iris-eval/mcp-server#readme)

## License

MIT
