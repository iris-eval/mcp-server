# Smithery — listing copy
> **Rendered from `.claims.json` by `npm run llms:render`; `llms:check` fails if this file and its template disagree.** Edit `docs/launch/listings/smithery.template.md`, never this file. Every number is a slot. Never write "first", "best", "leading" or "standard"; never say Iris captures or scores anything "automatically" — under MCP a tool call is the model's decision, and the two capture paths that do not depend on it (`POST /api/v1/traces`, the `iris-eval-capture` plugin) are named as such. The paste is the listing owner's act.


**Listing:** not live yet; published from the release's MCPB bundle. Smithery lists a local server from an MCPB bundle it is sent (https://smithery.ai/docs/build/publish, read 2026-09-25: `smithery mcp publish ./server.mcpb -n <org>/<name>`, a multipart upload), and reads the name, icon, tools and settings it shows from the bundle's manifest. Each release attaches that bundle, `iris-eval.mcpb`, built from the published npm package, signed and attested (`mcpb/manifest.json`, `scripts/mcpb/pack.mjs`). The `smithery.yaml` stdio form this repository once carried (a `startCommand` over `npx {{npmPackage}}` with a config schema) was not that path, cited a project-configuration docs page that returns 404, and drifted from `server.json`; it stays retired.

## Publish (the listing owner, once per release)

1. Download this release's bundle and check it was built by the release workflow:

   ```bash
   curl -fLO {{repoUrl}}/releases/download/v{{version}}/iris-eval.mcpb
   gh attestation verify iris-eval.mcpb -R iris-eval/mcp-server
   ```

2. Sign in to Smithery (a browser sign-in): `npx -y @smithery/cli auth login`
3. Publish the bundle under the organisation's namespace: `npx -y @smithery/cli mcp publish ./iris-eval.mcpb -n iris-eval/iris-eval`
4. Finish the flow Smithery opens, then use the Description field and the check below. The settings form comes from the bundle: two optional judge keys and a dashboard switch, none required.

## Description field

{{tagline}}. Iris is an open-source MCP server that scores every agent run for quality, safety, and cost. {{mcpToolCount}} tools your MCP client lists on connect — no SDK, no code changes. {{ruleCount}} built-in rules ({{piiPatterns}} PII patterns, {{injectionPatterns}} prompt-injection patterns, {{hallucinationMarkers}} hallucination signals, cost thresholds, and {{trajectoryRuleCount}} that read the agent's tool calls) score deterministically and free; a detected PII leak, injection or blocklist hit fails the verdict whatever the score says, and every verdict names the layer that decided it. Optional LLM judge ({{llmJudgeTemplateCount}} templates, your own key, a hard per-call cost cap) and citation verification for the semantic questions. {{dataResidency}} MIT-licensed core.

## One-liner

{{tagline}}. An MCP server that scores every agent run for quality, safety, and cost — {{ruleCount}} deterministic rules, local SQLite, MIT licensed.

## The check before you save

The listing must say **v{{version}}**, **{{mcpToolCount}} tools**, **{{ruleCount}} rules**, and the identifier **`iris-eval`** (the config key, the plugin and the command are all `iris-eval`; `iris` and `iris-mcp` are retired names). If any field on the form still shows an older number or the word "first", replace it — a live listing is not historical content.

## Links

- Repository: {{repoUrl}}
- Site: {{websiteUrl}} · capabilities: {{websiteUrl}}/capabilities · proof: {{websiteUrl}}/proof
- npm: https://www.npmjs.com/package/{{npmPackage}}
- Release notes: {{repoUrl}}/blob/main/CHANGELOG.md (current: v{{version}}, {{releaseDate}} — {{releaseHeadline}})
