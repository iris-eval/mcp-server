# Smithery — listing copy
> **Rendered from `.claims.json` by `npm run llms:render`; `llms:check` fails if this file and its template disagree.** Edit `docs/launch/listings/smithery.template.md`, never this file. Every number is a slot. Never write "first", "best", "leading" or "standard"; never say Iris captures or scores anything "automatically" — under MCP a tool call is the model's decision, and the two capture paths that do not depend on it (`POST /api/v1/traces`, the `iris-eval-capture` plugin) are named as such. The paste is the listing owner's act.


**Listing:** retired, not listed. Smithery's publish path today (https://smithery.ai/docs/build/publish, read 2026-09-21) is a hosted HTTPS URL, or a local server shipped as an MCPB bundle through `smithery mcp publish ./server.mcpb -n <org>/<name>`. The `smithery.yaml` stdio form this repository carried (a `startCommand` over `npx @iris-eval/mcp-server` with a config schema) was not that path, cited a project-configuration docs page that now returns 404, and named four of the server's variables while the manifest named more — a second source of truth that drifted. It was removed; if a Smithery listing is wanted, the path is an MCPB bundle built from the published package and one `publish` by a maintainer, with the copy below.

## Description field

Stop shipping agents on vibes. Iris is an open-source MCP server that scores every agent run for quality, safety, and cost. 12 tools your MCP client lists on connect — no SDK, no code changes. 25 built-in rules (21 PII patterns, 37 prompt-injection patterns, 25 hallucination signals, cost thresholds, and 9 that read the agent's tool calls) score deterministically and free; a detected PII leak, injection or blocklist hit fails the verdict whatever the score says, and every verdict names the layer that decided it. Optional LLM judge (6 templates, your own key, a hard per-call cost cap) and citation verification for the semantic questions. Nothing leaves your machine unless you set IRIS_OTEL_ENDPOINT, which exports traces to the collector you name, or enable the LLM judge with your own key. MIT-licensed core.

## One-liner

Stop shipping agents on vibes. An MCP server that scores every agent run for quality, safety, and cost — 25 deterministic rules, local SQLite, MIT licensed.

## The check before you save

The listing must say **v0.17.0**, **12 tools**, **25 rules**, and the identifier **`iris-eval`** (the config key, the plugin and the command are all `iris-eval`; `iris` and `iris-mcp` are retired names). If any field on the form still shows an older number or the word "first", replace it — a live listing is not historical content.

## Links

- Repository: https://github.com/iris-eval/mcp-server
- Site: https://iris-eval.com · capabilities: https://iris-eval.com/capabilities · proof: https://iris-eval.com/proof
- npm: https://www.npmjs.com/package/@iris-eval/mcp-server
- Release notes: https://github.com/iris-eval/mcp-server/blob/main/CHANGELOG.md (current: v0.17.0, 2026-09-23 — Hostile input, honest verdicts, a harder release path)
