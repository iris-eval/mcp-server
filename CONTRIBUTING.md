# Contributing to Iris

Thank you for your interest in contributing to Iris. We welcome contributions that improve the project for everyone.

## Contributor License Agreement

By submitting a pull request, you agree to our [Contributor License Agreement](.github/CLA.md). This is required before any contribution can be reviewed or merged. The CLA ensures that the project can be maintained, distributed, and — if necessary — relicensed in the future.

## AI-Generated Code

You are welcome to use AI tools (Copilot, Claude, etc.) to assist with your contributions. However, by submitting a PR, you represent that you have reviewed all code for correctness and security, and that you accept full responsibility for the contribution under the CLA — regardless of how it was generated.

## Security

If you discover a security vulnerability, **do not open a public issue**. Please email security@iris-eval.com instead. See [SECURITY.md](SECURITY.md) for details.

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
