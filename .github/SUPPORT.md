# Getting help with Iris

| You want to | Go to |
|---|---|
| Ask how to do something | [Discussions → Q&A](https://github.com/iris-eval/mcp-server/discussions/categories/q-a) |
| Suggest a feature, a rule or an integration | [Discussions → Ideas](https://github.com/iris-eval/mcp-server/discussions/categories/ideas), or the [feature request form](https://github.com/iris-eval/mcp-server/issues/new?template=feature_request.yml) when you know what you want built |
| Report a bug | The [bug report form](https://github.com/iris-eval/mcp-server/issues/new?template=bug_report.yml) |
| Report a security vulnerability | Privately, never in a public issue: [private vulnerability reporting](https://github.com/iris-eval/mcp-server/security/advisories/new) or security@iris-eval.com. The policy, supported versions and response targets are in [SECURITY.md](https://github.com/iris-eval/mcp-server/blob/main/SECURITY.md) |
| Show what you built with Iris | [Discussions → Show and tell](https://github.com/iris-eval/mcp-server/discussions/categories/show-and-tell) |
| Anything else | [Discussions → General](https://github.com/iris-eval/mcp-server/discussions/categories/general), or hello@iris-eval.com |

## Before you ask

Most install problems are answered in a minute by the self-test:

```bash
npx @iris-eval/mcp-server --self-test   # offline diagnostic; exit 0 = healthy
npx @iris-eval/mcp-server --version
```

Put both outputs in your question or bug report, with your MCP client and operating system. The [troubleshooting section of the README](https://github.com/iris-eval/mcp-server#first-move-run-the-self-test) covers the common cases: a server that will not start, tools that do not show up, the SQLite binding, updating and downgrading.

## Documentation

- [README](https://github.com/iris-eval/mcp-server#readme): install, first run, configuration and security
- [docs/](https://github.com/iris-eval/mcp-server/tree/main/docs): the API reference, custom rules, the CI gate, HTTP ingest, OpenTelemetry and the architecture guide
- [iris-eval.com](https://iris-eval.com): the [playground](https://iris-eval.com/playground), the measured accuracy of every rule on [the proof page](https://iris-eval.com/proof), the [client list](https://iris-eval.com/clients) and the [capability map](https://iris-eval.com/capabilities)

## What happens to a bug report

A maintainer triages it with a priority, an area and a milestone where one applies. A `P0`, a shipped surface that reports success while failing, leaks data or blocks install, goes out in the next patch release before anything else ships. The full vocabulary is in [.github/LABELS.md](https://github.com/iris-eval/mcp-server/blob/main/.github/LABELS.md).

To contribute the fix yourself, start with [CONTRIBUTING.md](https://github.com/iris-eval/mcp-server/blob/main/CONTRIBUTING.md).
