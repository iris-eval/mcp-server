#!/usr/bin/env node
// `npx iris-eval` resolves this package by its unscoped name. It starts the
// real server, @iris-eval/mcp-server, whose entry reads the same argv.
await import('@iris-eval/mcp-server');
