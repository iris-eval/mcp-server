# cursor.directory — listing refresh copy
> **Rendered from `.claims.json` by `npm run llms:render`; `llms:check` fails if this file and its template disagree.** Edit `docs/launch/listings/cursor-directory.template.md`, never this file. Every number is a slot. Never write "first", "best", "leading" or "standard"; never say Iris captures or scores anything "automatically" — under MCP a tool call is the model's decision, and the two capture paths that do not depend on it (`POST /api/v1/traces`, the `iris-eval-capture` plugin) are named as such. The paste is the listing owner's act.


**Listing:** https://cursor.directory/plugins/iris. **The slug is the one identity the freeze cannot reach:** the product's identifier is `iris-eval` on every surface we own (config key, plugin, skill, command), and the listing still carries the bare `iris`. Ask the listing to rename the slug to `iris-eval` when editing; until it does, the description and the config block below carry the right name.

## Description field

Stop shipping agents on vibes. Iris is an open-source MCP server that scores every agent run for quality, safety, and cost. 12 tools your MCP client lists on connect — no SDK, no code changes. 20 built-in rules (19 PII patterns, 37 prompt-injection patterns, 25 hallucination signals, cost thresholds, and 6 that read the agent's tool calls) score deterministically and free; a detected PII leak, injection or blocklist hit fails the verdict whatever the score says, and every verdict names the layer that decided it. Optional LLM judge (5 templates, your own key, a hard per-call cost cap) and citation verification for the semantic questions. Nothing leaves your machine unless you set IRIS_OTEL_ENDPOINT, which exports traces to the collector you name, or enable the LLM judge with your own key. MIT-licensed core.

## One-liner

Stop shipping agents on vibes. An MCP server that scores every agent run for quality, safety, and cost — 20 deterministic rules, local SQLite, MIT licensed.

## Config block (the form's MCP JSON field)

```json
{
  "mcpServers": {
    "iris-eval": {
      "command": "npx",
      "args": ["@iris-eval/mcp-server", "--dashboard"]
    }
  }
}
```

## The check before you save

The listing must say **v0.12.1**, **12 tools**, **20 rules**, and the identifier **`iris-eval`** (the config key, the plugin and the command are all `iris-eval`; `iris` and `iris-mcp` are retired names). If any field on the form still shows an older number or the word "first", replace it — a live listing is not historical content.

## Links

- Repository: https://github.com/iris-eval/mcp-server
- Site: https://iris-eval.com · capabilities: https://iris-eval.com/capabilities · proof: https://iris-eval.com/proof
- npm: https://www.npmjs.com/package/@iris-eval/mcp-server
- Release notes: https://github.com/iris-eval/mcp-server/blob/main/CHANGELOG.md (current: v0.12.1, 2026-09-07 — Truth patch 3)
