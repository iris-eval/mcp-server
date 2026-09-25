#!/usr/bin/env node
// `npx iris-eval` resolves the unscoped npm name. This package starts the real
// server, @iris-eval/mcp-server, whose entry reads the same arguments, so
// `npx iris-eval --self-test` and `npx iris-eval install <client>` are the
// server's own commands. The dependency range is open-ended, so a fresh
// install takes the server's latest release and this package never needs one.
await import('@iris-eval/mcp-server');
