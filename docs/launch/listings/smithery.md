# Smithery — listing copy
> **Rendered from `.claims.json` by `npm run llms:render`; `llms:check` fails if this file and its template disagree.** Edit `docs/launch/listings/smithery.template.md`, never this file. Every number is a slot. Never write "first", "best", "leading" or "standard"; never say Iris captures or scores anything "automatically" — under MCP a tool call is the model's decision, and the two capture paths that do not depend on it (`POST /api/v1/traces`, the `iris-eval-capture` plugin) are named as such. The paste is the listing owner's act.


**Listing:** not live yet; published from the release's MCPB bundle. Smithery lists a local server from an MCPB bundle it is sent (https://smithery.ai/docs/build/publish, read 2026-09-25: `smithery mcp publish ./server.mcpb -n <org>/<name>`, a multipart upload), and reads the name, icon, tools and settings it shows from the bundle's manifest. Each release attaches that bundle, `iris-eval.mcpb`, built from the published npm package, signed and attested (`mcpb/manifest.json`, `scripts/mcpb/pack.mjs`). The `smithery.yaml` stdio form this repository once carried (a `startCommand` over `npx @iris-eval/mcp-server` with a config schema) was not that path, cited a project-configuration docs page that returns 404, and drifted from `server.json`; it stays retired.

## Publish (the listing owner, once per release)

1. Download this release's bundle and check it was built by the release workflow:

   ```bash
   curl -fLO https://github.com/iris-eval/mcp-server/releases/download/v0.19.0/iris-eval.mcpb
   gh attestation verify iris-eval.mcpb -R iris-eval/mcp-server
   ```

2. Sign in to Smithery (a browser sign-in): `npx -y @smithery/cli auth login`
3. Publish the bundle under the organisation's namespace: `npx -y @smithery/cli mcp publish ./iris-eval.mcpb -n iris-eval/iris-eval`
4. Finish the flow Smithery opens, then use the Description field and the check below. The settings form comes from the bundle: two optional judge keys and a dashboard switch, none required.

## Description field

Stop shipping agents on vibes. Iris is an open-source MCP server that scores every agent run for quality, safety, and cost. 12 tools your MCP client lists on connect — no SDK, no code changes. 25 built-in rules (21 PII patterns, 38 prompt-injection patterns, 25 hallucination signals, cost thresholds, and 9 that read the agent's tool calls) score deterministically and free; a detected PII leak, injection or blocklist hit fails the verdict whatever the score says, and every verdict names the layer that decided it. Optional LLM judge (7 templates, your own key, a hard per-call cost cap) and citation verification for the semantic questions. Nothing leaves your machine unless you set IRIS_OTEL_ENDPOINT, which exports traces to the collector you name, or enable the LLM judge with your own key. MIT-licensed core.

## One-liner

Stop shipping agents on vibes. An MCP server that scores every agent run for quality, safety, and cost — 25 deterministic rules, local SQLite, MIT licensed.

## The check before you save

The listing must say **v0.19.0**, **12 tools**, **25 rules**, and the identifier **`iris-eval`** (the config key, the plugin and the command are all `iris-eval`; `iris` and `iris-mcp` are retired names). If any field on the form still shows an older number or the word "first", replace it — a live listing is not historical content.

## Links

- Repository: https://github.com/iris-eval/mcp-server
- Site: https://iris-eval.com · capabilities: https://iris-eval.com/capabilities · proof: https://iris-eval.com/proof
- npm: https://www.npmjs.com/package/@iris-eval/mcp-server
- Release notes: https://github.com/iris-eval/mcp-server/blob/main/CHANGELOG.md (current: v0.19.0, 2026-09-25 — Verdicts that say how sure they are, detectors that see through disguises, and one command to set up any client)
