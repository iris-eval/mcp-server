#!/usr/bin/env node
// This package holds the unscoped npm name `iris-eval` and nothing else. Iris
// is published as @iris-eval/mcp-server; this says so and exits. It has no
// dependencies and never needs a new release: the commands below do not
// change when the server does.
process.stderr.write(
  [
    'iris-eval: this npm package is a placeholder. Iris is published as @iris-eval/mcp-server.',
    '',
    '  Run the server:        npx -y @iris-eval/mcp-server',
    '  Set up an MCP client:  npx -y @iris-eval/mcp-server install <client>',
    '  See the clients:       npx -y @iris-eval/mcp-server install --help',
    '',
    'https://github.com/iris-eval/mcp-server',
    '',
  ].join('\n'),
);
process.exitCode = 1;
