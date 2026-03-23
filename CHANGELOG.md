# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
