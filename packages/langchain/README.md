# @iris-eval/langchain

Evaluate LangChain agent output with [Iris](https://iris-eval.com) — the agent eval standard for MCP. Auto-trace runs, score output quality, catch safety failures.

## Install

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
