# awesome-mcp-servers — the one-line row
> **Rendered from `.claims.json` by `npm run llms:render`; `llms:check` fails if this file and its template disagree.** Edit `docs/launch/listings/awesome-mcp-servers.template.md`, never this file. Every number is a slot. Never write "first", "best", "leading" or "standard"; never say Iris captures or scores anything "automatically" — under MCP a tool call is the model's decision, and the two capture paths that do not depend on it (`POST /api/v1/traces`, the `iris-eval-capture` plugin) are named as such. The paste is the listing owner's act.


**Listed:** yes, in the **📊 Monitoring** section of the `punkpeye/awesome-mcp-servers` README, between `hyperb1iss/lucidity-mcp` and `imprvhub/mcp-status-observer` (the list's order there, kept as it is). mcpservers.org mirrors the line, so the row is also that directory's description. A refresh of the line is open as [punkpeye/awesome-mcp-servers#13573](https://github.com/punkpeye/awesome-mcp-servers/pull/13573) from the `iris-eval` organisation's fork, branch `iris-eval/refresh-listing`.

**How it changes:** a one-line PR from that fork, rebased on upstream `main`, whose diff touches exactly the Iris line and nothing else (an earlier PR carried thousands of line-ending changes and had to be rebuilt to one line).

## The row

The list's own format: owner/repo as the link text, the Glama score badge, then the scope icons from the list's legend, then the description.

```markdown
- [iris-eval/mcp-server](https://github.com/iris-eval/mcp-server) [![iris-eval/mcp-server MCP server](https://glama.ai/mcp/servers/iris-eval/mcp-server/badges/score.svg)](https://glama.ai/mcp/servers/iris-eval/mcp-server) 📇 🏠 🍎 🪟 🐧 - Stop shipping agents on vibes: scores every agent output for quality, safety, and cost. Detects PII, credentials and prompt injection, checks grounding and tool use, compares runs with confidence intervals, and publishes the measured accuracy of its rules. Optional LLM judge and local SQLite dashboard.
```

## Why the line carries no numbers

A line in someone else's README changes only when a maintainer merges a PR, so a version, a tool count or a rule count in it goes stale the day after a release. The row states what Iris does; the numbers live on the pages this repository updates itself (the README, the site, the release notes).

## The icons

| Icon | Legend meaning | Why it is true |
|---|---|---|
| 📇 | TypeScript codebase | the server is TypeScript |
| 🏠 | local service | Iris runs on the user's machine; traces stay in local SQLite |
| 🍎 🪟 🐧 | macOS, Windows, Linux | the npm package and its SQLite driver install on all three; CI runs Linux and macOS, and the suite is also run on Windows during development |

☁️ (cloud service) is left off: no hosted Iris is running today (the site's cloud page is a waitlist). It goes back on the day one is.

## The labels the list's bot applies

The upstream workflow `.github/workflows/check-glama.yml` reads only the PR diff, so an edit to a line that is already listed always draws two labels that do not apply:

- `duplicate` — the bot flags any added line whose repository URL is already in the README. The Iris URL appears once.
- `missing-glama` — the bot counts the Glama badge only on lines whose URL is new, so an edited line never counts. The badge is on the line and its page resolves.

The PR body says both, and the maintainer reviews such PRs by hand (`manual-review`).

## Links

- Repository: https://github.com/iris-eval/mcp-server
- Site: https://iris-eval.com · capabilities: https://iris-eval.com/capabilities · proof: https://iris-eval.com/proof
- npm: https://www.npmjs.com/package/@iris-eval/mcp-server
- Glama: https://glama.ai/mcp/servers/iris-eval/mcp-server
