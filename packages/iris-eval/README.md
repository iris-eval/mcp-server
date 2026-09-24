# iris-eval

`npx iris-eval` starts [Iris](https://iris-eval.com), the MCP server that scores every agent output for quality, safety and cost.

This package only launches the server. The server, its documentation and its releases live in [`@iris-eval/mcp-server`](https://www.npmjs.com/package/@iris-eval/mcp-server), which this package installs at its latest release.

```
npx iris-eval --self-test
npx iris-eval --dashboard
```

For an MCP client config, use the server package directly:

```
npx -y @iris-eval/mcp-server
```

Source: [github.com/iris-eval/mcp-server](https://github.com/iris-eval/mcp-server) · MIT
