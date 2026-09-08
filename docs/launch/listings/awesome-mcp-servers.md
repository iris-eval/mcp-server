# awesome-mcp-servers — the one-line row
> **Rendered from `.claims.json` by `npm run llms:render`; `llms:check` fails if this file and its template disagree.** Edit `docs/launch/listings/awesome-mcp-servers.template.md`, never this file. Every number is a slot. Never write "first", "best", "leading" or "standard"; never say Iris captures or scores anything "automatically" — under MCP a tool call is the model's decision, and the two capture paths that do not depend on it (`POST /api/v1/traces`, the `iris-eval-capture` plugin) are named as such. The paste is the listing owner's act.


**Where:** the `punkpeye/awesome-mcp-servers` README, under the developer-tools / evaluation section where the existing Iris line sits. **How:** a one-line PR from the `iris-eval` organisation's fork — a diff that touches exactly that line and nothing else (a previous PR carried thousands of line-ending changes and had to be rebased to one line). mcpservers.org mirrors this line, so the row is also that directory's description.

## The row

```markdown
- [Iris](https://github.com/iris-eval/mcp-server) - Stop shipping agents on vibes. An MCP server that scores every agent run for quality, safety, and cost — 20 deterministic rules, local SQLite, MIT licensed. [![Glama AAA](https://glama.ai/mcp/servers/iris-eval/mcp-server/badges/score.svg)](https://glama.ai/mcp/servers/iris-eval/mcp-server) [![MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/iris-eval/mcp-server/blob/main/LICENSE)
```

## The check before you save

The listing must say **v0.13.0**, **12 tools**, **20 rules**, and the identifier **`iris-eval`** (the config key, the plugin and the command are all `iris-eval`; `iris` and `iris-mcp` are retired names). If any field on the form still shows an older number or the word "first", replace it — a live listing is not historical content.

## Links

- Repository: https://github.com/iris-eval/mcp-server
- Site: https://iris-eval.com · capabilities: https://iris-eval.com/capabilities · proof: https://iris-eval.com/proof
- npm: https://www.npmjs.com/package/@iris-eval/mcp-server
- Release notes: https://github.com/iris-eval/mcp-server/blob/main/CHANGELOG.md (current: v0.13.0, 2026-09-08 — Found and fed)
