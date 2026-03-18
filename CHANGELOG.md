# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
