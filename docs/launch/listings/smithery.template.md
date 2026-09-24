# Smithery — listing copy
> **Rendered from `.claims.json` by `npm run llms:render`; `llms:check` fails if this file and its template disagree.** Edit `docs/launch/listings/smithery.template.md`, never this file. Every number is a slot. Never write "first", "best", "leading" or "standard"; never say Iris captures or scores anything "automatically" — under MCP a tool call is the model's decision, and the two capture paths that do not depend on it (`POST /api/v1/traces`, the `iris-eval-capture` plugin) are named as such. The paste is the listing owner's act.


**Listing:** retired, not listed. Smithery's publish path today (https://smithery.ai/docs/build/publish, read 2026-09-21) is a hosted HTTPS URL, or a local server shipped as an MCPB bundle through `smithery mcp publish ./server.mcpb -n <org>/<name>`. The `smithery.yaml` stdio form this repository carried (a `startCommand` over `npx {{npmPackage}}` with a config schema) was not that path, cited a project-configuration docs page that now returns 404, and named four of the server's variables while the manifest named more — a second source of truth that drifted. It was removed; if a Smithery listing is wanted, the path is an MCPB bundle built from the published package and one `publish` by a maintainer, with the copy below.

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
