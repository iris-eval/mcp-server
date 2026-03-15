# Contributing to Iris

## Development Setup

```bash
git clone https://github.com/iris-eval/mcp-server.git
cd mcp-server
npm install
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with tsx |
| `npm run build` | Build TypeScript |
| `npm run typecheck` | Type check without emitting |
| `npm test` | Run unit tests |
| `npm run test:integration` | Run integration tests |
| `npm run test:coverage` | Run tests with coverage |
| `npm run lint` | Lint source code |
| `npm run format` | Format with Prettier |

## Dashboard Development

```bash
cd dashboard
npm install
npm run dev    # Starts Vite dev server with HMR
```

The dev server proxies API requests to `http://localhost:6920`.

## PR Process

1. Fork the repo and create a feature branch
2. Make your changes
3. Ensure all tests pass: `npm test && npm run test:integration`
4. Ensure code is formatted: `npm run format:check`
5. Submit a PR with a clear description of changes

## Coding Standards

- TypeScript strict mode
- ESM modules (no CommonJS)
- Vitest for testing
- Write to stderr for logging (stdout reserved for stdio transport)
- Serialize complex objects as JSON in SQLite columns
- Use Zod schemas for MCP tool input validation
