# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

(Unreleased content rolls forward to the next non-RC release.)

## [0.4.5] - 2026-08-07

**Security release.** Fixes three vulnerabilities present in 0.4.4, two of them found by driving iris the way a real user does — a live MCP session over stdio and an operator poking the HTTP transport — rather than by reading the code. Every dependency advisory across all four workspaces is also closed: `npm audit` reports **0 vulnerabilities** in the root, website, dashboard and `packages/init`.

No MCP surface changes: the same 9 tools, same schemas, same eval rules.

### Security

- **DNS rebinding on the MCP HTTP transport.** The MCP spec requires servers to validate `Origin` on HTTP transports; iris validated nothing. Because `security.apiKey` is `undefined` by default (making the auth middleware a pass-through), a default `--transport http` server was reachable from **any web page the operator visited** via a hostname rebound to `127.0.0.1` — exposing traces and eval history, and allowing rule deployment and trace deletion. Reproduced against 0.4.4 (`Origin: https://evil.example.com` → **200, request executed**); now **403**. Enabled the SDK's DNS-rebinding protection with an `Origin` allowlist, plus a `Host` allowlist when bound to loopback. Real MCP clients (Claude Desktop, Cursor, the CLI) send no `Origin` header and are unaffected — verified. `IRIS_ALLOWED_ORIGINS` now feeds this allowlist; it previously reached only the dashboard despite being advertised in `--help`. PR #283.
- **Absolute install path disclosed in dashboard 404s (CWE-209).** Any unmatched route returned `ENOENT: ... stat 'C:\...\dist\dashboard\index.html'`, leaking the install directory and OS username to anyone who could reach the dashboard. Two causes: the SPA fallback was gated on the `dist/dashboard` *directory* (which exists after `npm run build` even when the UI bundle does not), and the error handler echoed `err.message` verbatim below HTTP 500. Node system errors are now answered generically; genuine 4xx messages (body-parser size limits, Zod validation) still surface. PR #286.
- **`@hono/node-server` → 2.1.0** closes GHSA-frvp-7c67-39w9 (`serveStatic` path traversal on Windows via encoded backslash). This package sits on the real request path — SDK 1.29+ made `StreamableHTTPServerTransport` a thin wrapper that statically imports `getRequestListener` — so the upgrade was validated by exercising the transport, not just the unit suite. Requires SDK ≥ 1.30.0, which widens the constraint. PR #288.
- **Dependency advisories closed across every workspace:** `fast-uri` → 3.1.5, `ip-address` → 10.4.0, `postcss` → 8.5.26, `brace-expansion` → 5.0.9 (both major lines in website, via version-scoped overrides), `next` → 16.2.11, `sharp` → 0.35.0, `undici` → 7.29.0, `js-yaml` → 4.3.1, `ws` → 8.21.3, `body-parser` → 2.3.0, `hono` → 4.13.1. PRs #271, #274, #281, #288, #294 and the Dependabot drain.

### Fixed

- **Custom rules built from iris's own documentation never worked.** The `deploy_rule` tool description — the text an LLM agent reads to construct its call — specified `config.min` and `config.max_usd`, while the evaluator read `config.min_length` and `config.max_cost`. Deploy-time validation accepted any object, so a rule written from our docs deployed cleanly and then failed on *every* evaluation, forever. Worse, a rule that cannot run returned `score: 0` rather than skipping, so one broken rule silently deflated every aggregate score with no sign the rule (not the agent) was at fault. A correct output scored **0.304 / FAILED**; the same rules now score **1.0 / PASSED** and do what their author asked. Config keys now come from one shared module so the evaluator, the deploy validator and the tool description cannot drift apart; the spellings the old docs taught are honoured as aliases so already-deployed rules start working. Invalid configs are rejected at deploy time with the offending field named. PR #282.
- **Misleading regex errors.** `safe-regex2` returns false for anything it cannot parse, so a plainly broken pattern like `(` was reported as *"catastrophic backtracking"* — sending the author after a performance problem they did not have. Syntax is now checked before safety in both the evaluator and the deploy validator. PR #282.
- `docs/api-reference.md` taught the wrong `min_length` config key. PR #282.

### Changed

- **`zod` 3.25.76 → 4.4.3** and **`react-router` 7 → 8** (the dashboard drops `react-router-dom`, which has no 8.x). Internal only — no change to the MCP tool surface. PRs #292, #293.
- **CI can no longer deadlock against itself.** `npm audit --audit-level=high` ran inside `lint-and-typecheck` and fails on the *whole set* of open advisories, so four HIGHs turned **every** PR red — including each Dependabot PR that fixed one of them. No single PR could go green, so nothing merged and nothing drained: 4 advisories froze 40 PRs. Removed, with the invariant recorded in three places: *a blocking gate must be satisfiable by a change made inside the pull request it blocks.* Dependency-security enforcement remains in the `security-exposure` job, which is stricter (≥moderate, and demands documented threat-model analysis) and cannot deadlock. PR #271.
- Release workflows no longer `npm install -g npm@latest` before publishing; Node 24 ships a new-enough npm, so the unpinnable supply-chain dependency in the OIDC publish job is gone. The Docker dashboard build uses `npm ci` instead of `npm install`, making the image reproducible. PRs #285, #290.

### Added

- **A drift guard that deploys every rule-config example in our documentation** (51 of them) through the real schema. Numeric claims already had gates; nothing checked that the examples we tell users to copy actually run. Verified to fail, not just pass. PR #284.
- Regression coverage for all of the above: config errors skip instead of scoring 0, documented aliases are honoured, deploy rejects each invalid config shape, the rebinding attack is refused while Origin-less clients are not, and 404s carry no filesystem path. Root suite 434 → 511.


## [0.4.4] - 2026-06-12

Recovery release completing v0.4.3's distribution. v0.4.3 published to Docker (GHCR) and the GitHub Release, but its **npm publish silently failed** — the `NPM_TOKEN` secret had expired, npm returned `E404` on the publish PUT, and the pre-#176 `npm publish ... || echo "skipping"` step swallowed the failure into a green run. npm `@latest` (and therefore the MCP Registry + downstream mirrors) stalled at 0.4.2, so the v0.4.3 LLM-judge prompt-injection hardening never reached npm installs. v0.4.4 carries all v0.4.3 runtime content forward and is the first complete distribution since 0.4.2. **No runtime code changes versus 0.4.3.**

### Changed

- **npm publishing migrated to Trusted Publishing (OIDC).** `release.yml` no longer uses a long-lived `NPM_TOKEN` secret — the publish job authenticates via the workflow's GitHub OIDC identity, configured as a trusted publisher on npmjs.com (`iris-eval/mcp-server` + `release.yml`). This eliminates the credential-expiry failure mode that broke the v0.4.3 npm publish. Requires npm ≥ 11.5.1, upgraded in-job (Node 22 ships npm 10.x). The fail-loud publish step from #176 is retained as defense-in-depth. PRs #194 + #195.

### Security

- **esbuild 0.28.0 → 0.28.1** ([GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr), [GHSA-gv7w-rqvm-qjhr](https://github.com/advisories/GHSA-gv7w-rqvm-qjhr), HIGH). Transitive dev/build dependency (via `tsx` + `vite`/`vitest`) — not present in the shipped npm tarball or the Docker runtime, so no runtime exposure; both CVEs are dev-only (dev-server arbitrary file read on Windows; Deno-module integrity). Lockfile-only bump; both consumers already accept the patched range. PR #195.

## [0.4.3] - 2026-05-21

Security + supply-chain release. Hardens LLM-as-Judge against the arxiv 2504.18333 prompt-injection class across all five eval templates, validates the Signed-Releases workflow (npm + Docker SBOMs now ship with `cosign sign-blob` `.sig` / `.pem` companions), per-advisory threat-model record, fast-uri override, and a `security-exposure` CI gate that fails any PR introducing an undocumented ≥medium advisory.

### Security

- **LLM-judge prompt-injection defense in all five eval templates.** Pre-fix, attacker-controlled `output` (and `input` / `expected` / `sourceMaterial`) was concatenated directly after a label string with no delimiter, no escape, and no tail reinforcement — the canonical position for a successful "system override" injection per [arxiv 2504.18333](https://arxiv.org/abs/2504.18333) (up to 73.8% success rate against unhardened LLM judges). The candidate text was the LAST thing the judge LLM read before scoring, exploiting recency bias. The fix in `src/eval/llm-judge/templates/index.ts` (1) wraps every untrusted field in `<untrusted_<label> id="<nonce>">` tags with a per-call random 48-bit nonce so attacker-forged close tags cannot be guessed, (2) injects a `SECURITY:` notice into every template's system prompt instructing the judge to treat tag contents as data and never adopt instructions from inside the tags, (3) appends a tail reinforcement after the closing tag restating the JSON contract so the candidate is no longer the most-recent authority. The `safety` template additionally ties an in-band injection attempt to a `injection_compliance: 0.0` score so the existing dimension produces an actionable signal instead of silent compliance. Regression tests in `tests/unit/eval/llm-judge/templates.test.ts` cover all five templates plus a canonical arxiv 2504.18333-style attack payload. Score distributions may shift slightly (~±0.05 typical) for outputs adjacent to the new template phrasing — score history before this commit was generated under the prior prompt; re-evaluate trended metrics with fresh runs if comparing across the boundary. PR #173.
- **Per-advisory threat-model record (`SECURITY-EXPOSURE.md`).** Repo-root file documents the load-graph reachability, code-path reachability, untrusted-input reachability, and downstream-guard analysis for every open Dependabot advisory. Each entry carries an explicit decision: override (force a fixed transitive via `package.json` `overrides`), dismiss-as-not-used (vulnerable code not loaded into iris's process), dismiss-as-tolerable-risk (code loaded but vulnerable function never called), track (waiting on upstream), or patch (iris-side mitigation required). Closes the substance/signal gap where the GitHub Security tab counts advisories without distinguishing reachable from dead-code alerts. Linked from `SECURITY.md`.
- **`fast-uri ^3.1.2` override.** `package.json` `overrides` field forces the patched fast-uri across the dependency tree, covering [GHSA-v39h-62p7-jpjc](https://github.com/advisories/GHSA-v39h-62p7-jpjc) (host confusion via percent-encoded authority delimiters, HIGH) and [GHSA-q3j6-qgpj-74h6](https://github.com/advisories/GHSA-q3j6-qgpj-74h6) (path traversal via percent-encoded dot segments, HIGH). Reachability analysis indicated iris's citation-verify SSRF guards (scheme allowlist, private-IP block, DNS pre-resolve) do not depend on fast-uri's correctness, but defense-in-depth against the URI-validation bypass is cheap.
- **CI gate: `security-exposure` job in `.github/workflows/ci.yml`.** Runs `scripts/security/check-exposure-coverage.mjs` on every PR. Fails the build if any open Dependabot alert at severity ≥ medium does not have a corresponding GHSA row in `SECURITY-EXPOSURE.md`. Forces every new advisory to be triaged with a documented decision instead of accumulating silently. Pairs with `docker-build` (also added previously) as the second structural gate that catches a class of drift the PR-only test suite couldn't.
- **Signed Releases workflow validated.** Both SBOMs (npm + Docker) now ship with companion `.sig` (Sigstore signature) and `.pem` (Sigstore-issued cert) files attached to the GitHub Release page alongside the SBOMs themselves. Validated against v0.4.3-rc.0 tag (npm `next` dist-tag); the production pipeline is the same. Acquirers + enterprise procurement can verify supply-chain provenance from the GitHub Release page without separate tooling.

## [0.4.3-rc.0] - 2026-05-16

Release-candidate to validate the **Signed-Releases** workflow shipped in PR #158. Substance is rolled forward into [0.4.3] above — this RC tag remains in CHANGELOG for historical traceability. Published as npm dist-tag `next` (never `latest`); Docker tag `v0.4.3-rc.0` only.

## [0.4.2] - 2026-05-06

Recovery release for v0.4.1's Docker-publish failure. v0.4.1 npm package was published but the Docker image, GitHub Release, cosign signature, and SLSA Docker attestation never materialised — the v0.4.1 tarball was unpublished from npm; v0.4.2 is the first complete distribution after the truthbase landing.

### Removed

- **`src/lib/claims.ts` (server-side truthbase reader)** — added speculatively in PR #139 with no `src/` consumer, so it shipped as dead code in v0.4.1's npm tarball. The dead-code import (`import claimsRaw from '../../.claims.json' with { type: 'json' }`) caused the v0.4.1 Docker build to fail at typecheck because `.claims.json` was not in the Docker build context (and not in the npm `files` allowlist either). When a server-side consumer of the truthbase is actually needed, the reader should be re-introduced **in the same PR as the consumer**, including the Dockerfile `COPY .claims.json ./` and the `package.json` `files` allowlist update. Per CLAUDE.md: no half-finished implementations; don't design for hypothetical future requirements.
- **`dashboard/src/lib/claims.ts` (dashboard-side truthbase reader)** — same logic. No dashboard consumer, vite tree-shook it out of the build, dead code. Re-introduce alongside its first dashboard consumer.

### Changed

- **PR CI now runs a `docker-build` smoke job on every PR.** Single-arch (`linux/amd64`), no push, gha cache backend so warm runs stay under ~2 min. Catches Docker-only build regressions before they reach a release tag (the gap that allowed the v0.4.1 incident — host typecheck passed, Docker tsc failed inside the build). `.github/workflows/ci.yml` (job: `docker-build`, depends on `lint-and-typecheck`).

## [0.4.1] - 2026-05-06 [WITHDRAWN]

> **Note:** v0.4.1 was published to npm but the Docker, GitHub Release, cosign, and SLSA-Docker artifacts never landed because the Docker build failed (see v0.4.2 entry above). The npm tarball was unpublished within npm's 72-hour window; this version is no longer installable. All substance of v0.4.1 ships in v0.4.2.

Hygiene release. Truthbase + claims-alignment CI guard close the bug class behind the hero `374→413` recurrence. Dashboard a11y + race-condition hardening. Three security fixes (CORS allowlist, DNS pre-resolve SSRF guard, tenant gate on /rules/custom). Cloud-tier groundwork (CustomRuleStore tenant API). Five dependency bumps. No breaking changes for OSS deployments.

### Added

- **Truthbase — single source of truth for facts about Iris.** `iris/.claims.json` is regenerated from canonical artifacts (`package.json`, `vitest --reporter=json`, MCP tool registry, eval rule registry, LLM-judge templates, CHANGELOG headers) via `npm run claims:generate`. Reader modules at `src/lib/claims.ts`, `website/src/lib/claims.ts`, `dashboard/src/lib/claims.ts` expose typed constants (`VERSION_MCP_SERVER`, `TEST_COUNT_VITEST_ROOT`, `MCP_TOOL_COUNT`, `RULE_COUNT_BUILT_IN`, `LLM_JUDGE_TEMPLATE_COUNT`, `TAGLINE`, etc.) for surfaces to import instead of hardcoding. Hardcoded-claim scanner (`scripts/claims/check-no-hardcoded.mjs`) catches new drift; `.github/workflows/claims-alignment.yml` runs the scanner + verifies the regenerator output matches the committed `.claims.json` on every PR + push to main. Surface migrations in this PR: `website/src/components/hero.tsx` (test count claim) + `website/src/app/page.tsx` (JSON-LD `softwareVersion`). Allow-list (`scripts/claims/allow-list.json`) carries explicit exemptions for historical CHANGELOG entries, version-snapshot roadmap rows, and the seven website-component / docs sites flagged as migration candidates for follow-on PRs. Closes the bug class that produced the hero `374→413 tests` recurrence after the linear-elephant remediation. The `374` literal no longer exists; the surface reads `{TEST_COUNT_VITEST_ROOT}` from the regenerated truthbase. New scripts: `claims:capture-tests` (CI wrapper around `vitest --reporter=json`), `claims:generate`, `claims:check`, `claims:check-hardcoded`. Documented at `scripts/claims/README.md`.

### Accessibility

- **Focus trap on dashboard modals.** New `useFocusTrap` hook (`dashboard/src/components/shared/useFocusTrap.ts`) applied to `MakeRuleModal`, `WelcomeTour`, and the `EvalListPage` evaluation-detail dialog. Tab cycles inside the modal panel; focus is restored to the trigger element on close. Closes the keyboard / screen-reader gap where users could Tab into background page content while a modal was open. Tests: `dashboard/tests/components/shared/useFocusTrap.test.tsx`.

### Changed

- **Dashboard rapid-navigation race fix.** `useApiData` (`dashboard/src/api/hooks.ts`) now tags each fetch with a monotonic request id and discards stale resolutions. Previously, a slow earlier fetch could resolve AFTER a newer fetch and overwrite the user-visible data with the previous page's results. Closes the race where filter/route changes during in-flight requests showed wrong data. Also discards stale errors so a failed older request can't flip error state after a newer success. `HealthView`'s "Retry now" button now skips the call while still inside an active rate-limit window (was triggering an immediate fail-loop with no spinner). Tests: `dashboard/tests/components/shared/useApiData-race.test.tsx`.
- **`CustomRuleStore` API now accepts `TenantId` as the first argument on every public method (`list` / `get` / `deploy` / `delete` / `setEnabled` / `enabledRules`).** OSS deployments are unaffected — the tenant middleware always resolves to `LOCAL_TENANT`, and the default file path for `LOCAL_TENANT` remains `~/.iris/custom-rules.json` (zero migration). Cloud tenants get per-tenant file partition (`~/.iris/custom-rules-<sanitized-tenantId>.json`) so one tenant's data can never poison another's. The constructor now accepts `pathFor: (tenantId) => string` instead of `rulesPath: string` so Cloud orchestrators can inject their own routing. Audit log entries now carry the resolved `tenantId` instead of a hardcoded `'local'`. `src/custom-rule-store.ts`. Internal API change — no public package consumer affected.

### Security

- **CORS allowlist now matches a single hostname/port label per `*` wildcard.** Previously `pattern.replace(/\*/g, '.*')` substituted `.*` (matches dots/colons/slashes), so an entry like `http://localhost:*` would also match a malicious origin like `http://localhost:8080.evil.com`. Substitution is now `[^.:/]+`. Any allowlist entry that previously matched origins crossing a label boundary will now be rejected — review your `security.allowedOrigins` config if you rely on multi-label subdomain matching (use multiple explicit entries instead). `src/middleware/cors.ts`.
- **DNS pre-resolve guard against citation-verify SSRF via DNS rebinding.** `resolve.ts` now resolves every public hostname via `dns.lookup({all:true})` and re-checks every returned address against the IP blocklist before fetching, defeating the bypass where a public hostname (e.g. `*.localtest.me`) resolves to `127.0.0.1`. A residual TOCTOU window between the pre-resolve and the socket connect remains; closing it requires controlling the socket via a custom undici dispatcher and is queued for follow-up. `src/eval/citation-verify/resolve.ts`.
- **Tenant gate on `/rules/custom` (GET, POST, DELETE).** All three handlers now call `requireTenant(req)` before acting. In OSS the tenant middleware always resolves to `LOCAL_TENANT`, so behavior is unchanged for self-hosted deployments. In Cloud (v0.5+), unauthenticated requests bypassing the auth+tenant middleware will now fail-closed at the route layer instead of operating on un-tenanted state. The actual storage threading (`CustomRuleStore` accepting a `TenantId`) lands in PR 3b. Regression test: `tests/unit/dashboard/routes/rules-tenant-gate.test.ts`. `src/dashboard/routes/rules.ts`.

### Dependencies

- `safe-regex2` 5.1.0 → 5.1.1 (#101).
- `express-rate-limit` 8.3.2 → 8.5.0 (#126).
- `anchore/sbom-action` 0.9.0 → 0.24.0 (CI; #127).
- Testing group bump (#110).
- Linting group bump (#107).

## [0.4.0] - 2026-04-24

The semantic-eval release. v0.4.0 ships LLM-as-Judge (5 templates, cost-capped) + semantic citation verification (SSRF-guarded fetch + per-claim LLM verdict) + OpenTelemetry export (OTLP/HTTP JSON) + 6 new MCP tools (3→9 total: `list_rules`, `deploy_rule`, `delete_rule`, `delete_trace`, `evaluate_with_llm_judge`, `verify_citations`) — all on top of the enterprise-readiness foundation (tenant isolation 4-layer, SBOM + cosign + SLSA build-provenance, Playwright E2E × 2 browsers, Storybook 10, Lighthouse CI, axe a11y, per-view polling + RateLimitBanner, v2.C chrome). 372/372 tests pass; bundle 497 KB under 600 KB budget.

### Added

- **OpenTelemetry trace export (OTLP/HTTP JSON)** — when `IRIS_OTEL_ENDPOINT` is set, every `log_trace` call also fires a best-effort async export of the trace to the configured OTel collector (Jaeger, Grafana Tempo, Datadog OTLP, or any receiver accepting OTLP/HTTP at `/v1/traces`). Hand-rolled mapper (`src/otel/mapper.ts`) + exporter (`src/otel/exporter.ts`) against the OTLP JSON spec — no `@opentelemetry/*` deps, consistent with the LLM client and citation resolver approach. Iris Span → OTLP Span: hex-normalizes trace/span IDs (with deterministic fallback for non-hex Iris IDs), emits nanosecond timestamps as decimal strings (BigInt-safe for uint64 range), flattens attributes to OTel AnyValue tagged union (string/bool/int/double/arrayValue/kvlistValue), preserves parent-span tree, surfaces Iris-specific kinds (LLM/TOOL) as `iris.span_kind` attributes while mapping kind field to INTERNAL. Synthesizes a root span from trace-level fields when the trace has no explicit span tree. Environment: `IRIS_OTEL_ENDPOINT` (URL; `/v1/traces` auto-appended if omitted), `IRIS_OTEL_SERVICE_NAME` (default `iris-mcp`), `IRIS_OTEL_HEADERS` (comma-sep `k=v` pairs for auth), `IRIS_OTEL_TIMEOUT_MS` (default 15000). Export failures log to stderr but never block `log_trace` — operator-visible via the prefixed `[iris.otel]` log lines. 32 unit tests: 15 mapper (basic mapping + all 3 status codes + Iris-kind preservation + nested kvlist/arrayValue/doubleValue + events with nano timestamps + non-hex ID fallback + synthesized root span from trace fields), 10 exporter (URL normalization with and without trailing slash, env var parsing including malformed header entries, empty-trace short circuit, 5xx error surfacing, network abort handling), 5 lazy (memoization, no-op when unset, error forwarding, no-throw on crash). gRPC transport not included in v0.4 — the hand-rolled approach needs protobuf support that's not worth the surface for v0.4; front gRPC-only receivers with an HTTP-accepting OTel Collector.
- **Semantic citation verification (`verify_citations`, 9th MCP tool)** — end-to-end pipeline: (1) regex extraction of four citation kinds from agent output (`[N]` numbered, `(Author, Year)` parenthetical, bare URLs, DOIs); (2) SSRF-guarded source resolver (`src/eval/citation-verify/resolve.ts`) with scheme allowlist (http/https only), private-IP block (localhost, 127/8, 10/8, 172.16-31/12, 192.168/16, 169.254/16, ::1, fc00::/7, fe80::/10) + cloud-metadata host block (`metadata.google`, `metadata.azure`, AWS IMDS at 169.254.169.254), optional domain allowlist via `IRIS_CITATION_DOMAINS`, 10s per-URL timeout, 5MB body cap, manual redirect chase (max 3 hops, re-checked against SSRF rules each hop), text-only content types (refuses `application/octet-stream`, binary formats), in-process LRU cache; (3) per-citation LLM judge verdict using a dedicated system prompt ("does the source support the claim in context?") returning `{supported, confidence, rationale}`. Returns overall-support score + per-citation provenance. Cost-capped across the entire call via `max_cost_usd_total` (default $1.00) — stops before the next judge call would exceed the cap. Opt-in: outbound HTTP only fires when `allow_fetch=true` is passed OR `IRIS_CITATION_ALLOW_FETCH=1` is set. 46 unit tests covering extractor (numbered/author-year/URL/DOI + invalid forms), resolver (SSRF rejection for every private range + cloud metadata, scheme/status/content-type/redirect checks, cache, DOI normalization), and verifier (happy path, cost cap, mixed supported/unsupported, max_citations cap, unknown model rejection). Integration test asserts 9th tool annotations (`openWorldHint:true`) + 5-section description.
- **LLM-as-Judge eval (`evaluate_with_llm_judge`, 8th MCP tool)** — semantic scoring via Anthropic (`claude-opus-4-7` / `claude-sonnet-4-6` / `claude-haiku-4-5-20251001`) or OpenAI (`gpt-4o` / `gpt-4o-mini` / `o1-mini`). Five prompt templates: `accuracy` (factual correctness, hallucination detection), `helpfulness` (does it address the ask), `safety` (harm-potential judge beyond regex PII), `correctness` (vs reference answer — passes `expected`), `faithfulness` (RAG grounding — passes `source_material`). Cost-capped per eval via `IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL` (default $0.25) with pessimistic pre-check — refuses the call if worst-case cost exceeds the cap before spending a cent. Single-retry on 429 using `Retry-After`/`RateLimit-*` headers; single-retry on malformed-JSON with stricter prompt. Returns score + passed + rationale + dimensions + `cost_usd` + `latency_ms` + `input_tokens` + `output_tokens` + provider response ID. Auth via `IRIS_ANTHROPIC_API_KEY` or `IRIS_OPENAI_API_KEY` (resolved at call time, not startup — missing keys only fail the tool that needs them, not the whole server). 24 unit tests with mocked fetch + integration test asserting the 8th tool registers with correct annotations (`readOnlyHint:false`, `destructiveHint:false`, `idempotentHint:false`, `openWorldHint:true`) + 5-section description.
- **MCP tool surface expanded 3 → 9 (full rule + trace lifecycle via protocol + LLM-as-judge + citation verification)** — `list_rules` enumerates deployed custom rules (read-only), `deploy_rule` registers a new rule so it fires on every `evaluate_output` of that category (shared custom-rule store with dashboard — deploy via MCP, see it in dashboard without restart), `delete_rule` removes a deployed rule (destructive, idempotent — re-delete returns `deleted:false`, not an error), `delete_trace` removes a single trace by ID (destructive, tenant-scoped). Agents can now close the discover-deploy-audit-retire loop without a human-in-the-loop dashboard session. Tenant-scoped audit entries on every mutation. Round-trip coverage in `tests/integration/mcp-protocol.test.ts` (11 tests, up from 7).
- **Glama Tool Definition Quality 5/5 target** — every tool carries MCP annotations (`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`) so MCP clients can reason about safety before invocation. Every description follows a 5-section template: Behavior (side effects, auth, rate limits) / Output shape / Use when / Don't use when / Error modes. Annotation + description-section assertions are in the integration suite so regressions fail CI.
- **Tenant isolation (4-layer defense-in-depth)** — branded `TenantId` type (`src/types/tenant.ts`), `assertTenant()` runtime guard, migration 004 adds `tenant_id TEXT NOT NULL DEFAULT 'local'` to every data table with composite `(tenant_id, *)` indexes, every `IStorageAdapter` method takes `TenantId` as first parameter. OSS single-node deployments see only `'local'`; Cloud tier gets multi-tenant boundaries without a future data migration. Regression coverage in `tests/unit/storage/sqlite-adapter.test.ts` + `migration-tenant.test.ts`.
- **Tenant resolver middleware** (`src/middleware/tenant.ts`) threads `req.tenantId` through every Express handler; MCP tool handlers and file-based stores (custom-rule, preferences, audit-log) also tenant-scoped. Audit log entries now carry `tenantId`.
- **Dashboard bundle-size budget gate** (`scripts/check-bundle-size.mjs`) — JS 600 KB raw / 160 KB gzip, CSS 20 KB raw / 8 KB gzip. Raising budgets requires editing the script with justification.
- **Chart a11y** — every SVG chart primitive has `<desc>` with concrete data values (WCAG 1.1.1). `PassRateAreaChart` and `StackedBarByDay` have visually-hidden `<ol>` drill-through lists so AT users reach every destination without fighting nested-interactive SVG. `tests/a11y/charts.test.tsx` axe-tests 15 chart states.
- **Detail-page section semantics + v2.A tokens** — `MomentDetailPage` and `TraceDetailPage` now wrap every section in `<section aria-labelledby>` with proper h2/h3 hierarchy. Tokens migrated from legacy aliases (`--bg-secondary`, `--accent-primary`, `--font-size-*`) to canonical v2.A (`--bg-card`, `--iris-500`, `--text-body-sm`). `tests/a11y/detail-pages.test.tsx` covers 8 states.
- **Playwright E2E suite** (`tests/e2e/`) — globalSetup seeds 20 traces + 20 evals + 1 audit entry across 7 days (deterministic). Three spec files: `smoke.spec.ts` (6 tests — view rendering + nav), `drill-through.spec.ts` (3 tests — verdict donut, top-failing-rules, biggest-movers navigation), `make-rule.spec.ts` (1 test — POST /rules/custom → verify in /rules + audit log with tenantId). CI job runs headless Chromium; Playwright report uploaded as artifact.
- **SBOM + cosign + SLSA build-provenance attestations** in release workflow. Each tag produces `iris-npm-sbom.spdx.json` + `iris-docker-sbom.spdx.json` (attached to GitHub release), cosign keyless signature on the Docker image (`cosign verify ghcr.io/iris-eval/mcp-server:vX.Y.Z`), and GitHub-signed `attest-build-provenance` attestations on both artifacts. `id-token: write` + `attestations: write` permissions; `npm publish --provenance` retained.
- **Customer-facing security page** at iris-eval.com/security — data-location explainer, tenant isolation 4-layer detail, supply-chain verification recipes, runtime defenses, STRIDE scope summary, vuln reporting SLA, compliance roadmap. Linked from footer + sitemap.
- **Storybook 10 primitive catalog** (`dashboard/.storybook/`) — 7 stories shipped (PageHeader, PageEmptyState, Badge, LoadingSpinner, CopyableId, PassRateGauge, RateLimitBanner). CI runs `npm run build-storybook` as a smoke gate.
- **Per-view polling cadence** (`FAST 3s` / `NORMAL 10s` / `SLOW 30s`) in `dashboard/src/api/hooks.ts`. Live tail stays fast, trends + audit + rules move to slow. Previously 5s for most hooks put 3 open views over the 100 req/min rate limit.
- **Typed `RateLimitError`** with RFC 9110 / RateLimit-* header parsing. `useApiData` returns `rateLimitedUntil` and pauses polling until the server's reset time; auto-resumes on the next successful fetch. 9 unit tests.
- **`RateLimitBanner`** — alert-role countdown banner with manual retry button, wired into `HealthView`. Shown only when hooks surface `rateLimitedUntil`.
- **AccountMenu popover** (circle-I avatar in header) — theme switcher (Dark / Light), density toggle (Compact / Comfortable), links to /security, architecture docs, release notes. Escape + outside-click close. `menuitemradio` for theme + density with `aria-checked`.
- **NotificationsPopover** (Bell icon in header) — 10 most recent audit entries with per-action icon + relative time, unread badge based on `preferences.notificationsLastSeen`, auto-marks on open, "View all →" link to /audit.
- **DensitySync** — applies `preferences.density` to `<html data-density>`, mirrors ThemeProvider pattern.

### Changed

- **Audit log entry schema** — `tenantId` field now optional on read (backward-compatible for v0.3.x entries without it) and written on every deploy/delete/toggle/update by `custom-rule-store.ts`.
- **Header chrome** — theme toggle moved from header into AccountMenu per R2.5. Notification + account buttons are now real popovers (were v2.B stubs).
- **Release workflow** permissions — added `attestations: write` for `attest-build-provenance`.
- **Architecture doc** (`docs/architecture.md`) — §5 schema + indexes updated for migration 004; §8 gains "Tenant isolation" and "Supply-chain integrity" subsections.

### Fixed

- **F-006 port collision** — running `iris-mcp --transport http --port N --dashboard --dashboard-port N` previously bound MCP on port N and silently failed to start the dashboard (EADDRINUSE swallowed); every dashboard route returned "Cannot GET /" from the MCP handler. New pre-flight check in `validatePortConfig` throws a clear error at startup; dashboard's `app.listen()` now also attaches an `'error'` handler as defense-in-depth. Covered by 5 unit tests in `tests/unit/validate-port-config.test.ts`.

### Infrastructure

- **CI** — `dashboard/npm run build-storybook` smoke; new `e2e` job installs Chromium via `npx playwright install --with-deps chromium`, runs suite, uploads Playwright report artifact (30-day retention).
- **v0.3 → v0.4 migration test** (`tests/unit/storage/migration-tenant.test.ts`) creates a v0.3 schema manually, opens with v0.4 adapter, verifies backfill to `LOCAL_TENANT` + cross-tenant isolation + migration idempotency.

### Breaking

- **Storage schema** — `tenant_id` is NOT NULL on traces/spans/eval_results. Migration 004 backfills existing rows with `'local'`; v0.3.x → v0.4.0 is a clean upgrade path (smoke-tested). Custom storage adapters implementing `IStorageAdapter` must update every method signature to take `tenantId: TenantId` as first parameter.

## [0.3.1] - 2026-04-22

Eval rule library expansion + new `no_stub_output` rule + topic_consistency fix. Backed by an exhaustive controlled trace-log validation harness (parent repo: `tools/iris-validation-harness/`) and a new in-repo regression gate (`tests/integration/rule-coverage-matrix.test.ts`). 209/209 tests pass; 55 controlled cases verify every rule. No breaking changes.

### Added

- **`no_pii`** — expanded from 4 to 10 PII patterns. Added IBAN (international bank account), DOB (with explicit label), Medical Record Number (MRN), IPv4 address, API key heuristic (`sk-` / `pk-` / `api_*` / `Bearer` + 20+ char token), US Passport (9-digit). Catches significantly more real-world PII leaks in customer support, healthcare data extraction, and DevOps log scenarios.
- **`no_injection_patterns`** — expanded from 5 to 13 patterns. Added "disregard previous", "act/behave/respond as a/an", "pretend you are/to be", "override instructions/safety", "my/your (new) role/task is", "reveal/show/tell system prompt", "jailbroken", "forget all/everything/previous". Catches the broader output-side compliance patterns that emerge when an injection succeeds.
- **`no_stub_output`** (new rule, safety category) — detects placeholder/stub markers in agent output (TODO, FIXME, PLACEHOLDER, XXX, TBD, HACK, NOT YET IMPLEMENTED, TO BE DETERMINED, [INSERT, [ADD). Configurable via `customConfig.stub_markers`. Critical for code-review agents emitting "LGTM TODO: review later", data-extractors emitting `{"field": "TODO"}`, and content-drafters emitting `[FIXME: add stats]`.
- **Fabricated-citation heuristic** in `no_hallucination_markers`. Fires when 3+ numbered citations (`[1][2][3]`) co-occur with 2+ expert markers (Dr., Professor, "according to", "study by"). Does NOT flag legitimate single citations or numbered step lists. Heuristic only — full semantic citation verification ships in v0.5 LLM-as-judge.
- **`tests/integration/rule-coverage-matrix.test.ts`** — 55-case regression gate that runs against all 13 built-in rules + every v0.3.1 expansion. Fails CI on any rule behavior change.

### Changed

- **`topic_consistency`** — now skips when output has < 6 words ≥ 4 chars (configurable via `customConfig.topic_consistency_min_words`). Resolves the false-positive where brief but valid responses were flagged as off-topic. Returns `skipped: true` + `passed: true` (benefit-of-the-doubt) for brief outputs.

### Validation

- 209/209 unit + integration tests pass.
- 57/57 controlled trace-log tests pass against the v0.3.1 build (validation harness in parent repo).
- All v0.3.0 behavior preserved; backward compatible.

## [0.3.0] - 2026-04-21

Dashboard Phase-1 visual core + pricing page. First minor since Mother Audit. No breaking changes.

### Added
- Dashboard: dark/light theme toggle in the header. Persists via `localStorage`; falls back to `prefers-color-scheme`. Closes #10.
- Dashboard: trace-ID copy-to-clipboard component (`<CopyableId />`). Adds an explicit "ID" column in `TraceTable` (last 8 chars + copy button) and replaces the inline `<code>` trace-ID display in `TraceDetailPage` with the copyable variant. Closes #11.
- Dashboard: per-rule eval-score sparkline component (`<EvalSparkline />`) using Recharts. Optional `sparkline` prop on `<StatCard />` renders a 7-day rolling trend beneath the value. Closes #12.
- Dashboard: `<ThemeProvider>` context wraps the app; theme is applied via `data-theme` attribute on `<html>`.
- Website: `/pricing` page with three-tier card grid (Free / Pro / Enterprise), per-evaluation pricing primitive, FAQ. Linked from primary nav + sitemap.

### Changed
- Dashboard: design tokens (`tokens.css`) migrated from sRGB hex to OKLCH. Light-theme variant gated by `[data-theme="light"]`. Accent colors theme-stable for brand recognition.
- Dashboard: typography tokens updated to Geist Variable (UI/display) + JetBrains Mono (data/code). Loaded via Google Fonts CDN with `display: swap`.
- Website: nav `Pricing` link points to `/pricing` (was `/#pricing` anchor).

### Removed
- None.

## [0.2.4] - 2026-04-17

Mother Audit Wave 2 follow-through. CLI hardening cluster + repo hygiene + content + tooling.

### Added
- CLI: Zod-validated arguments. `--transport` accepts only `stdio` or `http`. `--port` and `--dashboard-port` must be integers 1–65535. Invalid args fail with a specific error and exit code 2 (was: silent garbage acceptance).
- CLI: `--help` now lists every supported environment variable (`IRIS_TRANSPORT`, `IRIS_HOST`, `IRIS_PORT`, `IRIS_DB_PATH`, `IRIS_LOG_LEVEL`, `IRIS_DASHBOARD`, `IRIS_DASHBOARD_PORT`, `IRIS_API_KEY`, `IRIS_ALLOWED_ORIGINS`, `RATE_LIMIT_SALT`).
- `scripts/sync-versions.mjs` now syncs `package-lock.json` (root + `packages[""]` version metadata only — no `npm install`, lockfile-trap-safe).
- Blog `002-state-of-mcp-agent-observability-2026.md` carries an Editor's note acknowledging the observability→agent-eval framing pivot (matches Blog 001 pattern).

### Changed
- CLI: `parseArgs` now runs with `strict: true`. Unknown flags fail loudly. **Breaking change for any caller passing extra unrecognized flags.**
- `IRIS_PORT` and `IRIS_DASHBOARD_PORT` env vars now validated via the same range check (1–65535) and fail with a specific message if invalid (was: silent `NaN`).
- Storage error messages now include the allowed values: `Invalid sort column: X (allowed: timestamp, latency_ms, cost_usd)`, `Invalid sort order: X (allowed: asc, desc)`, `Column 'X' is not queryable (allowed: agent_name, framework)`, `Unsupported storage type: X (supported: sqlite)`.
- Hero badge alt text "Glama AAA Score" → "Glama Score" (the badge image is dynamic; alt should not assert a specific grade).

### Removed
- `archive/packages/{crewai,autogen}/` — empty conceptual scaffolds. The `(conceptual scaffold)` README labels remain for `examples/{langchain,crewai}/*.py`; full implementation OR conversion to spec.md is a separate decision (Master Action List S02).

## [0.2.3] - 2026-04-16

Mother Audit Wave 1 patch checkpoint. Five small surface-correctness fixes surfaced by an end-to-end audit (product + external surface + diligence lens). No product behavior changes.

### Fixed
- Homepage stat counters now render their values on first paint instead of "0" until scrolled into view (`stats.tsx` flips MCP-tools / eval-rules / latency to `static: true`; AnimatedCounter unchanged for in-component playground reveals)
- Sitemap now includes `/privacy` and `/terms` (the pages already existed; only the sitemap was missing them)

### Changed
- Nav banner badge bumped v0.2.1 → v0.2.3 (matches release tag)
- `SECURITY.md` Supported Versions table updated: `0.2.x` Yes, `0.1.x` No (was showing `0.1.x` only)
- `CHANGELOG.md` v0.2.2 entry: replaced "full-lattice audit" with "full-system audit" (carve-out hygiene; "Lattice" is reserved for parent-company IP terminology)

## [0.2.2] - 2026-04-16

Pre-YC alignment checkpoint — UX fixes from Session 31 full-system audit. No product behavior changes beyond the dashboard-tip log and retention cleanup guard.

### Added
- stdio startup logs a Tip pointing at `--dashboard` flag when not enabled (directly addresses user feedback: "if I didn't know it had a dashboard I wouldn't have known")
- `IRIS_HOST` and `IRIS_DASHBOARD_PORT` documented in README env var table
- README notes CLI flags take precedence over env vars

### Fixed
- Data retention cleanup on startup now logs a warning and continues on error instead of silently crashing the server (affects corrupt DB or disk-full scenarios)

### Changed
- README: dashboard promoted to its own `### Turn on the dashboard` section with copy-paste MCP config that already includes `--dashboard`
- README: LangChain and CrewAI examples labeled "(conceptual scaffold)" to match their actual state (they're skeleton code for users to extend, not runnable as-is)
- Nav banner badge bumped v0.2 → v0.2.1 (coherence with v0.2.1 release)

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
