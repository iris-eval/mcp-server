# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-04-16

Pre-YC alignment pass. No product behavior changes — narrative, SEO, and hygiene only.

### Changed
- CLI `--help` banner: dropped "& Observability" from title — now reads "Iris — MCP-Native Agent Eval Server"
- Website `.well-known/mcp.json` description now uses canonical Agent Eval tagline (was "evaluation and observability server")
- Roadmap renumbered: v0.2 now "Released — Eval Sensitivity + Security Hardening"; Cloud Tier pushed to v0.3; LLM-as-Judge remains v0.4 (preserving blog 005/009 version references); Alerting v0.5; Enterprise v0.6
- Homepage JSON-LD `softwareVersion` bumped 0.1.8 → 0.2.0 (previously stale)
- DeepEval compare page maturity row bumped to v0.2.0
- Nav event banner badge bumped v0.1 → v0.2
- `packages/langchain` unprivated (publishable): added `files` array, `prepublishOnly`, bumped `@iris-eval/mcp-server` peer dep from ^0.1.7 to ^0.2.0
- Author field unified to org form (`Iris <hello@iris-eval.com>`) across `package.json` and `packages/langchain/package.json`

### Added
- `Compare` link in primary navigation (pages were only reachable via footer)
- `/waitlist` redirect to `/#waitlist` homepage anchor (was 404)
- `website/public/.well-known/security.txt` (RFC 9116 vulnerability disclosure endpoint)
- `relatedPosts` frontmatter on 11 blog posts (001–010, 026) to strengthen internal link graph for GSC indexing

### Fixed
- Blog 026 date reconciled from 2026-04-22 (future) to 2026-03-29 (matches Dev.to publish date, restores canonical)
- Blog 001 editor's note points readers to current thesis (preserves historical framing)

### Archived
- `packages/crewai` and `packages/autogen` moved to `archive/packages/` (scaffolded stubs, no implementation)

### Docs
- `scripts/sync-versions.mjs` header comment explains why dashboard and companion packages are excluded from version sync

## [0.2.0] - 2026-04-14

### Breaking Changes
- **Eval scores will be lower** — rules that previously auto-passed when context fields (expected, input, costUsd, tokenUsage) were missing now return `skipped` and are excluded from the weighted average instead of inflating the score to 1.0. This is the fix for the 100% pass rate problem.
- **Threshold increases** — `min_output_length` 10→50 chars, `sentence_count` 1→2, `keyword_overlap` 20%→35%, `topic_consistency` 5%→10%. Configurable via `ruleThresholds` in config.
- **"No rules configured" returns score 0** — was returning score 1.0 with `passed: true`, now returns `insufficient_data: true`.

### Added
- Eval rule skip system: rules that can't evaluate due to missing context return `skipped: true` with `skipReason`, excluded from weighted average
- `rules_evaluated`, `rules_skipped`, `insufficient_data` fields in eval results (API response + database)
- Configurable `ruleThresholds` in config system — override default thresholds per rule
- DB migration 002: new columns for eval skip metadata
- 9 new hallucination markers (17 total) covering GPT/Claude/Gemini/Llama hedging patterns
- Content-Security-Policy header on website
- Permissions-Policy header on website
- HSTS `preload` directive on website

### Security
- SQL sort column/order whitelist in `queryTraces()` (defense-in-depth against injection)
- Default HTTP host changed from `0.0.0.0` to `127.0.0.1` (don't expose unauthenticated server to network)
- Waitlist admin key moved from query string to `Authorization: Bearer` header
- Rate limit salt fallback removed — `RATE_LIMIT_SALT` env var now required
- Waitlist count endpoint CORS restricted from wildcard to allowed origins
- CSV field escaping in waitlist export

### Fixed
- Dashboard async route handlers wrapped in try/catch (traces, evaluations, summary)
- Trace + span insertion wrapped in `db.transaction()` for atomicity
- `contains_keywords` / `excludes_keywords` custom rules no longer crash on missing `config.keywords`
- `cost_threshold` custom rule no longer produces `$undefined` message on missing `config.max_cost`
- Dashboard stats exclude skipped rules from per-rule breakdowns
- Release workflow adds `npm run clean` before build (prevents ~2.5 MB stale Vite bundles in npm package)
- `package.json` author field populated
- `.claude-plugin/plugin.json` version synced
- `smithery.yaml` default port corrected to 3000
- Plugin.json added to `sync-versions.mjs`
- Removed dead code: `useLocalStorage.ts`, unused `POLLING_INTERVAL` constant
- Removed redundant `.npmignore` (overridden by `"files"` whitelist)

## [0.1.9] - 2026-04-07

### Security
- **Vite dev server vulnerabilities** — bumped vite to 8.0.6 across root and dashboard, resolving 6 GitHub Dependabot alerts:
  - GHSA-v2wj-q39q-566r: `server.fs.deny` bypassed with queries (high)
  - GHSA-p9ff-h696-f583: arbitrary file read via Vite Dev Server WebSocket (high)
  - GHSA-4w7w-66w2-5vf9: path traversal in optimized deps `.map` handling (moderate)
  - All three are dev-server-only (no impact on shipped artifacts), but worth eliminating
- **Lodash removal from dashboard bundle** — bumped recharts 2.15.4 → 3.8.1, which drops the lodash dependency in favor of `es-toolkit`. Eliminates GHSA-r5fr-rjxr-66jc (`_.template` code injection) and GHSA-f23m-r3pf-42rh (prototype pollution) from the published dashboard. Bundle size dropped 47 KB (655 KB → 608 KB).

### Changed
- Bumped `@modelcontextprotocol/sdk` 1.28.0 → 1.29.0 (typings exports, ResourceSchema size field, `windowsHide` on Windows, capability extensions)
- Bumped `express-rate-limit` 8.3.1 → 8.3.2
- Bumped `react-router-dom` 7.13.2 → 7.14.0 (dashboard)
- Bumped dev dependencies: `eslint` 10.1.0 → 10.2.0, `@typescript-eslint/*` 8.57.2 → 8.58.0, `@types/node` 25.5.0 → 25.5.2

### Fixed
- Recharts 3.x type compatibility: `EvalTrendChart` Tooltip formatter signature updated to match the new generic `Formatter<ValueType, NameType>` shape

## [0.1.8] - 2026-03-25

### Fixed
- Custom eval rules: `min_length`/`max_length` now accept both `config.min_length` and `config.length` key names — previously only `config.length` worked, causing silent NaN scores and database insert failures when using the intuitive key name
- NaN guard in eval score aggregation — a single misconfigured rule can no longer crash the entire evaluation
- Cost precision: standardized to 4 decimal places across all APIs (`getEvalStats` was rounding to 2, `getDashboardSummary` to 4)
- Cost display: `formatCost()` now shows 4 decimals for all costs under $1 (was only under $0.01) — AI micro-costs in the $0.01-$0.99 range now display full precision
- Cost display consistency: `SafetyViolationsCard` now uses `formatCost()` instead of direct `.toFixed(2)`
- Dashboard summary: eval count excludes orphaned evaluations (those with no linked trace) so numbers tie out across views
- Dashboard filter dropdowns no longer trigger table row navigation on click (both Traces and Evaluations tabs)
- SQLite: added `busy_timeout = 5000` pragma to prevent blank trace detail page during concurrent read/write operations

### Added
- "All Time" period option on dashboard — previously only 24h/7d/30d were available, causing dashboard to show zeros when data was older than the default 7-day window
- 3 regression tests for custom eval rules (multi-rule scoring, dual config key, invalid config resilience)

## [0.1.7] - 2026-03-25

### Fixed
- **Critical:** Dashboard server backend files (`dist/dashboard/server.js`, routes, validation) were missing from every published npm package since v0.1.0 — Vite's `emptyOutDir: true` wiped TypeScript-compiled backend files during the frontend build. Changed to `emptyOutDir: false`.
- Dashboard health endpoint was returning hardcoded version `'0.1.0'` — now reads dynamically from server config
- Fallback version in `defaults.ts` updated from stale `'0.1.4'`
- LangChain example package dependency updated from `^0.1.3` to `^0.1.7`

### Security
- Updated picomatch to 4.0.4 across all subdirectories (GHSA-c2c7-rcm5-vvqj ReDoS, GHSA-3v7f-55p6-f55p method injection)

### Added
- Package integrity verification step in CI and release workflows — prevents regression of the missing dashboard files bug
- Platform-specific setup guides in README (Claude Desktop, Claude Code, Cursor/Windsurf)
- Troubleshooting section in README (npx cache, Windows `cmd /c` issue, Node version, updating)

## [0.1.6] - 2026-03-23

### Removed
- Node 18 support — Node 18 reached EOL April 2025. Minimum is now Node 20.

### Changed
- Upgraded vitest 3.x → 4.x and @vitest/coverage-v8 3.x → 4.x
- CI test matrix reduced from Node 18/20/22 to Node 20/22

## [0.1.5] - 2026-03-21

### Security
- Fixed stored XSS vulnerability in blog JSON-LD structured data (CodeQL alert #9) — added `sanitizeText()` with explicit HTML entity escaping for all file-sourced content rendered via `dangerouslySetInnerHTML`

### Fixed
- Server version string now reads from `package.json` dynamically — was hardcoded at 0.1.0 while package was 0.1.4
- Package description refined to "The agent eval standard for MCP. Score every agent output for quality, safety, and cost."
- MCP Registry manifest (`server.json`) description aligned with canonical messaging

### Added
- `pnpm-workspace.yaml` — authorizes better-sqlite3 and esbuild native module builds for pnpm v10+ environments (fixes Glama Docker build)
- `glama.json` — Glama MCP registry server claiming and metadata
- `sitemap.xml` — dynamic Next.js sitemap covering all pages with last-modified dates
- `robots.txt` — search engine crawl directives with sitemap pointer
- Canonical URLs on all blog posts via `alternates.canonical` metadata
- JSON-LD structured data: `BlogPosting` on blog posts, `Organization` site-wide, `SoftwareApplication` on homepage
- Future-date blog post filtering — posts with dates after current date are excluded from blog index, sitemap, and static generation
- Internal cross-links across all 15 blog posts (43+ contextual links)
- SEO-optimized `description` field in all blog post frontmatter
- Blog posts 011–015: Agent Eval vocabulary series (Eval Tax, Eval Drift, Eval Gap, Eval Coverage, Eval-Driven Development)
- Dev.to crosspost variants for vocabulary series with topic-specific tags
- Google Search Console domain verification and sitemap submission

### Changed
- All blog post author attribution standardized to "Ian Parent" (was inconsistently "Iris Team")
- Blog post dates staggered honestly across Mar 13–28 (was bulk Mar 17)
- Dev.to tags diversified per article topic (was uniform `mcp, aiagents, observability, opensource`)
- GitHub repository topics updated: added `evaluation`, `security`
- `blog.ts` prefers frontmatter `description` over auto-extracted first paragraph

## [0.1.4] - 2026-03-20

### Security
- Fixed Helmet CSP — replaced `contentSecurityPolicy: false` with restrictive policy on HTTP transport
- Added rate limiting to dashboard static file serving routes
- Upgraded better-sqlite3 to 12.8.0 (bundled SQLite 3.51.3 — CVE-2025-6965)

### Added
- Post-install message with playground link, docs URL, and star prompt
- Eval-first dashboard layout with score gauge, trend charts, and safety violation cards
- API reference and architecture guide (`docs/`)
- Custom eval rules guide and HTTP transport examples
- SECURITY.md, CLA, CODEOWNERS, branch protection
- Dependabot with grouped weekly updates
- CodeQL security scanning (push, PR, weekly)
- `npm audit --audit-level=high` in CI
- `check-product-claims.sh` in CI — validates marketing claims match source code
- Automated Dev.to blog cross-posting via GitHub Actions

### Changed
- Upgraded better-sqlite3 11.10.0 → 12.8.0
- Upgraded typescript-eslint 8.57.0 → 8.57.1
- Upgraded flatted 3.4.1 → 3.4.2
- Upgraded GitHub Actions: checkout v6, setup-node v6, Docker actions v4/v7
- README restructured with Docker badge, refined CTAs, and agent eval positioning

### Fixed
- Package description updated to "The agent eval standard for MCP"

## [0.1.3] - 2026-03-15

### Changed
- Bumped version for npm registry alignment

### Fixed
- GitHub homepage URL (was Vercel preview URL, now iris-eval.com)
- npm homepage URL (was GitHub README, now iris-eval.com)

## [0.1.2] - 2026-03-14

### Added
- Website: iris-eval.com deployed on Vercel (static HTML, auto-deploys from main)
- Waitlist API: POST /api/waitlist with Upstash Redis, rate limiting, CORS, GDPR-ready
- Admin export: GET /api/waitlist-export with timing-safe auth
- Vercel Web Analytics enabled
- .well-known/mcp.json for agent auto-discovery
- OG social preview image for link sharing
- FUNDING.yml with sponsor button linking to waitlist
- Pricing page with 3-tier model (Self-Hosted, Cloud Pro, Enterprise)
- Langfuse comparison page at /compare/langfuse
- Smithery marketplace config (smithery.yaml)
- Published to Official MCP Registry, Glama, npm, Docker

### Changed
- README restructured: problem statement, value props table, cloud tier section, config collapsed into details
- Hero badge colors updated

## [0.1.0] - 2026-03-13

### Added

#### Core
- MCP server with `log_trace`, `evaluate_output`, and `get_traces` tools
- MCP resources: `iris://dashboard/summary` and `iris://traces/{trace_id}`
- Stdio and streamable HTTP transports via MCP SDK v1.27
- CLI entry point with `--transport`, `--port`, `--db-path`, `--api-key`, `--dashboard` flags
- Configurable via defaults, `~/.iris/config.json`, environment variables, and CLI args

#### Storage
- SQLite storage with WAL mode for concurrent reads
- Migration system with version tracking
- 30-day retention with configurable cleanup
- JSON serialization for tool calls, token usage, and metadata

#### Evaluation
- Eval engine with weighted scoring and configurable pass/fail threshold (default 0.7)
- Completeness rules: min output length, non-empty, sentence count, expected coverage
- Relevance rules: keyword overlap, hallucination markers, topic consistency
- Safety rules: PII detection (SSN, CC, phone, email), blocklist, injection patterns
- Cost rules: cost threshold, token efficiency
- Custom rules: regex match/no-match, min/max length, keywords, JSON schema, cost threshold
- ReDoS protection via safe-regex2 for user-supplied patterns

#### Dashboard
- React 19 web dashboard with dark theme
- Summary page with metric cards and traces-per-hour chart (Recharts)
- Trace list with filtering, sorting, and pagination
- Trace detail with span tree, tool call cards, and evaluation results
- Evaluation list with type/pass-fail filtering

#### Security
- API key authentication with timing-safe comparison
- Configurable CORS with origin pattern matching (default: localhost only)
- Rate limiting: 100 req/min API, 20 req/min MCP endpoints
- Helmet security headers (CSP, X-Frame-Options, X-Content-Type-Options)
- Zod input validation on all dashboard routes
- Request body size limits (default: 1MB)
- Structured JSON logging via pino (writes to stderr)
- Graceful shutdown with connection draining

#### DevOps
- Docker multi-stage build with non-root user
- docker-compose configuration
- GitHub Actions CI (lint, typecheck, test on Node 18/20/22)
- GitHub Actions release (npm publish with provenance, Docker multi-arch push)
- MCP Registry manifest (server.json)
