# iris-eval

`npx iris-eval` starts [Iris](https://iris-eval.com), the MCP server that scores every agent output for quality, safety and cost.

This package only launches the server. The server, its documentation and its releases are [`@iris-eval/mcp-server`](https://www.npmjs.com/package/@iris-eval/mcp-server), which this package installs at its latest release.

```
npx iris-eval --self-test               # check that Iris runs here
npx iris-eval install <client>          # add Iris to an MCP client's config
npx iris-eval --dashboard               # open the dashboard
```

An MCP client config should name the server package and a version, which is what `install` writes:

```
npx -y @iris-eval/mcp-server@<version>
```

`npx` keeps a package it has installed, so `npx iris-eval` can go on running the server release it first fetched. `npx -y @iris-eval/mcp-server@latest` always fetches the newest.

Source: [github.com/iris-eval/mcp-server](https://github.com/iris-eval/mcp-server) · MIT
