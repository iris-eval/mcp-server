# Iris Roadmap

Public roadmap for `@iris-eval/mcp-server`. Updated 2026-04-22.

The canonical public version lives at [iris-eval.com#roadmap](https://iris-eval.com/#roadmap). This file mirrors it with the per-version detail that doesn't fit on the marketing page.

---

## v0.1 -- Core MCP Server

**Status: Released**

The foundation: an MCP server that evaluates agent output quality, logs traces, and surfaces results in a web dashboard.

- **3 MCP tools**: `log_trace`, `evaluate_output`, `get_traces` with Zod-validated input schemas
- **Evaluation engine**: 12 built-in rules across 4 categories (completeness, relevance, safety, cost), weighted scoring with configurable threshold, custom rule support
- **SQLite storage**: single-file database via better-sqlite3, schema migrations, queryable trace and evaluation history
- **Web dashboard**: React-based dark-mode UI with summary cards, trace list, span tree view, and evaluation results (served via Express on port 6920)
- **Security hardening**: API key authentication, rate limiting (express-rate-limit), helmet security headers, CORS, input validation, ReDoS-safe regex, 1MB body limit
- **Dual transport**: stdio for local MCP clients (Claude Desktop, Cursor), HTTP for networked deployments

---

## v0.2 -- Eval Sensitivity + Security Hardening

**Status: Released**

Tighter evaluation signal and a deeper security posture for the self-hosted single-tenant deployment.

- **Smart rule exclusion**: rules that need input for meaningful comparison (`keyword_overlap`, `topic_consistency`, `expected_output_coverage`) skip when context is missing instead of producing noisy false positives
- **Configurable thresholds**: per-rule customization via `customConfig` payload (overlap ratios, brief-output skips, blocklist words, stub markers)
- **SQL whitelist**: dashboard query layer hardened with parameterized statements + table/column allowlist for ad-hoc filters
- **CSP headers + accessibility**: dashboard ships strict Content-Security-Policy; trace viewer is keyboard-navigable with ARIA labels on summary widgets
- **Rolldown lockfile guardrails**: release pipeline + Dockerfile pinned away from Windows-pruning native module patterns

---

## v0.3 -- Dashboard Phase-1 + Pricing

**Status: Released**

First pass of the production-grade dashboard, plus a public pricing surface.

- **OKLCH palette + dark/light theme**: perceptually uniform color system across both themes, full CSS variable token set
- **Trace-ID copy**: every trace exposes a one-click copy button for support flows and pasting into incident channels
- **Eval sparkline**: per-rule pass/fail trend over the last N traces, surfaced inline in the rule detail view
- **Pricing page**: free / team / enterprise tiers with usage-based add-ons, FAQ, and per-tier feature matrix
- **MCP-native validation harness**: external test agent system that exercises Iris through the MCP protocol (no direct DB writes), used as the primary release-readiness gate

---

## v0.3.1 -- Rule Library Expansion

**Status: Released**

Closing the pattern-coverage gaps surfaced by the controlled-trace test campaign. The rule library went from 12 to 13 rules with substantially broader pattern coverage in the existing safety/relevance rules.

- **`no_pii`** — expanded from 4 to 10 PII patterns. Added IBAN, US passport, date-of-birth (contextual), medical record number, IPv4 address, and API key heuristics on top of the original SSN/credit card/phone/email
- **`no_injection_patterns`** — expanded from 5 to 13 patterns. Added "disregard previous", "act/behave/respond as a/an", "pretend you are/to be", "override instructions/safety", "my/your (new) role/task is", "reveal/show/tell system prompt", "jailbroken", and "forget all/everything/previous"
- **`no_stub_output`** (new rule, safety category) — detects placeholder/stub markers in agent output (TODO, FIXME, PLACEHOLDER, XXX, TBD, HACK, NOT YET IMPLEMENTED, [INSERT, [ADD). Configurable via `customConfig.stub_markers`
- **Fabricated-citation heuristic** in `no_hallucination_markers` — fires when 3+ numbered citations co-occur with 2+ expert markers (Dr., Professor, "according to", "study by"). Heuristic only; semantic verification ships in v0.4
- **`topic_consistency`** brief-output skip — skips when output has < 6 words ≥ 4 chars (configurable). Resolves false-positives on brief but valid responses
- **`tests/integration/rule-coverage-matrix.test.ts`** — 55-case regression gate that runs against all 13 built-in rules. Fails CI on any rule behavior change

---

## v0.4 -- LLM-as-Judge + Semantic Citation + OTel + 9-Tool MCP Surface

**Status: Released (2026-04-24).** See [CHANGELOG](../CHANGELOG.md#040---2026-04-24) for the shipped feature list and verification recipes.

Semantic evaluation powered by LLMs, SSRF-guarded citation verification, export to industry-standard observability, expanded MCP tool surface covering the full rule + trace lifecycle plus LLM-as-judge + semantic citation verification, plus the enterprise-readiness foundation that makes Iris production-ready.

- **9 MCP tools (full rule + trace lifecycle + LLM-as-judge + citation verification)**: adds `list_rules`, `deploy_rule`, `delete_rule`, `delete_trace`, `evaluate_with_llm_judge`, `verify_citations` alongside the original `log_trace` / `evaluate_output` / `get_traces`. Agents can discover a failure pattern, deploy a rule programmatically, audit via `list_rules`, tear down when the rule is obsolete, score an output semantically via LLM, AND verify cited sources against the claims — all via MCP. `delete_trace` is tenant-scoped. `evaluate_with_llm_judge` is cost-capped and supports Anthropic + OpenAI. `verify_citations` extracts 4 citation kinds (numbered / author-year / URL / DOI), fetches sources via an SSRF-guarded resolver (scheme allowlist + private-IP block + optional domain allowlist + redirect re-check + 5MB cap + timeout), and runs a per-claim LLM judge
- **Tool Definition Quality** (5/5 Glama score target): every tool carries MCP annotations (`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`) and a 5-section description (Behavior / Output shape / Use when / Don't use when / Error modes)
- **LLM-as-judge evaluation**: use an LLM (OpenAI or Anthropic) to score output quality on dimensions like accuracy, helpfulness, and safety — configurable model, prompt templates, cost caps, token + pricing tracking
- **Semantic citation verification**: graduates the v0.3.1 fabricated-citation heuristic to actual source-checking via LLM-as-judge
- **OpenTelemetry trace export**: export Iris traces as OTel spans to Jaeger, Grafana Tempo, Datadog, Sentry via OTLP gRPC/HTTP
- **Tenant-id storage scaffolding**: `tenant_id` column on every data table, 4-layer defense-in-depth (type system + runtime guard + SQL scope + composite indexes). OSS sees only 'local'; v0.5 Cloud Tier builds on this
- **Supply-chain integrity**: SBOM + cosign keyless signing + SLSA build-provenance attestations on every release artifact
- **Playwright E2E in CI**: Chromium + Firefox; smoke + drill-through + Make-This-A-Rule flow
- **Storybook primitive catalog** + Lighthouse CI + bundle-size budgets + axe chart/detail/chrome coverage
- **v2.C chrome polish**: AccountMenu + NotificationsPopover + DensitySync
- **Customer-facing `/security` page** + architecture doc with tenant model + supply chain

---

## v0.5 -- Cloud Tier

**Status: Planned** — post-YC (summer 2026 target).

Managed Iris. Hosted, multi-tenant, team-collaboration-ready.

Includes three original v0.4 items that moved here because they only make sense alongside the hosted offering (see `strategy/product/v0.4-scope-decision-2026-04-23.md` for the decision record).

- **PostgreSQL storage adapter**: production-grade concurrent writes, connection pooling; directly couples to Cloud backend. *(Moved from v0.4.)*
- **Full multi-tenancy**: workspace isolation + user accounts + authentication + row-level-security enforcement (v0.4's tenant_id scaffolding is the foundation). *(Moved from v0.4.)*
- **Team eval dashboards**: shared eval results, team-level quality scores, agent-by-agent comparison. *(Moved from v0.4.)*
- **Managed hosting**: sign-up flow, onboarding, usage-based billing
- **Workspace switcher + member invites**

---

## v0.6 -- Alerting & Retention

**Status: Planned** — after Cloud Tier GA.

Alert on quality regressions and bound long-term storage. *(Cascaded from original v0.5.)*

- **Quality alert rules**: configurable conditions (e.g., average eval score drops below 0.6 over 1 hour, safety failure rate exceeds 5%, cost per trace exceeds $0.50)
- **Webhook notifications**: POST alert payloads to any URL (Slack, PagerDuty, custom endpoints)
- **Email notifications**: SMTP integration for alert emails with summary and affected evaluations
- **Retention policies**: automatic trace/eval deletion after configurable TTL (e.g., 30 days), storage usage tracking
- **Dashboard alert panel**: view active alerts, alert history, and configure rules from the UI
- **Drift detection**: automated alerts when eval scores trend downward per agent or per rule

---

## v0.7 -- Enterprise

**Status: Planned** — regulated + large-organization tier. *(Cascaded from original v0.6.)*

Features for regulated environments and large organizations.

- **SSO / SAML**: single sign-on via SAML 2.0 and OIDC providers (Okta, Azure AD, Google Workspace)
- **RBAC**: role-based access control with predefined roles (admin, editor, viewer) and custom roles
- **Audit logs**: immutable log of all user actions (trace access, config changes, API key operations) with export capability
- **SOC 2 compliance**: documentation, controls, and architecture changes to support SOC 2 Type II certification
- **SLA and support tiers**: uptime guarantees, priority support, dedicated onboarding for enterprise customers

---

## Community

**Status: Ongoing**

Community-driven features and ecosystem growth.

- **Framework integration guides**: step-by-step guides for using Iris with LangChain, CrewAI, AutoGen, Semantic Kernel, and the MCP SDK directly
- **Eval rule marketplace**: community-contributed evaluation rules published as npm packages, discoverable via a registry — the ESLint of agent output
- **Plugin system**: extend Iris with plugins for custom storage adapters, notification channels, authentication providers, and dashboard widgets
- **Example agents**: reference implementations of agents with Iris eval baked in, covering common patterns (RAG, tool-use, multi-agent)
- **Contributing guide**: documentation for contributing rules, storage adapters, and dashboard components

---

## How to Influence the Roadmap

- Open an issue on [GitHub](https://github.com/iris-eval/mcp-server/issues) with a feature request
- Upvote existing feature requests with a thumbs-up reaction
- Join the discussion in pull requests and issues
- Contribute directly -- see [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines
