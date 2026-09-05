# Iris Roadmap

Public roadmap for `@iris-eval/mcp-server`. Updated 2026-09-05.

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
- **Tenant-id storage scaffolding**: `tenant_id` column on every data table, 4-layer defense-in-depth (type system + runtime guard + SQL scope + composite indexes). OSS resolves every request to a single local tenant; the scaffolding means shared/hosted storage could be added later without reworking the storage layer
- **Supply-chain integrity**: SBOM + cosign keyless signing + SLSA build-provenance attestations on every release artifact
- **Playwright E2E in CI**: Chromium + Firefox; smoke + drill-through + Make-This-A-Rule flow
- **Storybook primitive catalog** + Lighthouse CI + bundle-size budgets + axe chart/detail/chrome coverage
- **v2.C chrome polish**: AccountMenu + NotificationsPopover + DensitySync
- **Customer-facing `/security` page** + architecture doc with tenant model + supply chain

---

## v0.5 through v0.8 -- Released

**Status: Released.** The per-version detail lives in the [CHANGELOG](../CHANGELOG.md): v0.5.0 (the context-grounded hallucination rule), v0.6.0 (the correctness release), v0.7.0 (the proof release — every built-in rule measured, the numbers on https://iris-eval.com/proof), v0.8.0 (the trajectory release — the first two rules that read the agent's tool calls), v0.8.1 (the honest-surfaces patch). Each release's own verification recipe is in its changelog entry.

---

## What comes next

**Status: mixed, and each item says which.** The work below is organised as three tracks rather than a version ladder, because they progress in parallel and gate each other. Every line is marked *shipped* (with the version) or *not shipped*; nothing unshipped is written in the present tense. The capability map — every evaluation question × every subject, with what Iris has, has weakly, and lacks — will replace this list as the canonical roadmap surface when it ships.

Iris is an evaluation tool, so the thing it owes you above all else is evidence that its own evaluations are correct. Track 1 is therefore first among equals — the other two are worth less without it.

---

### Track 1 -- Proof: measure our own evaluators, and publish the results

Every eval tool tells you your agent's score. Almost none tell you how often the evaluator itself is wrong. Iris does, including where the answer is unflattering.

- **Shipped (v0.7.0).** Per-rule precision, recall and F1 with Wilson 95% intervals for every built-in rule, on a labelled corpus committed in the repo (`proof/corpus/`), reproducible with `npm run proof`, regenerated and byte-checked in CI, published at https://iris-eval.com/proof with the misses listed by case id. The corpus is synthetic and labelled by the same model that wrote it; the page says so.
- **Shipped (v0.8.0).** The blind-sample instrument for human agreement (`proof/blind-sample.mjs`) — 40 cases; the label itself is pending.
- **Not shipped.** Human agreement on the blind sample. The LLM judge's and the citation verifier's own accuracy, stability and prompt/model sensitivity: the harness is complete (`npm run proof:judge`) and runs on a key you supply; no number is published until a keyed run is committed, and the proof page says "pending" until then. A labelled corpus for the top-level verdict (`passed`) rather than per-rule numbers; a threshold sweep; calibration; adversarial transforms (zero-width, homoglyph, whitespace); chance-corrected agreement (Cohen's kappa / Krippendorff's alpha); published precision at field prevalence rather than corpus prevalence. Each lands on https://iris-eval.com/proof when it is measured, and nowhere before.

This maps onto NIST AI RMF MEASURE 2.13 (evaluating the effectiveness of the evaluation methods themselves) and EU AI Act Article 15(3), which asks for declared accuracy metrics in the instructions for use.

### Track 2 -- Coverage: evaluate what actually fails

Published measurement is only useful if the rules are aimed at real failures. Coverage is strongest on single-output checks and still thin on everything that only appears across a trajectory.

- **Shipped (v0.5.0).** The context-grounded hallucination rule: pass `input` and the output's specific claims (attributed numbers, quotes, sections, table bindings, booleans, dates, versions, statuses) are cross-checked against the provided material. A private 90-case gold corpus showed the old rule caught 0 of 46 real hallucinations; the public, reproducible numbers for the rewrite live at https://iris-eval.com/proof.
- **Shipped (v0.8.0).** The first trajectory rules, reading `tool_calls`: `no_silent_tool_failure` (a tool call that failed and an output that never acknowledges it) and `no_tool_loop` (the same call repeated past a configurable limit). Rules that need the trajectory skip, and say so, when it is not supplied.
- **Not shipped.** Argument validity against the agent's own tool catalogue; grounding the output's identifiers in what the tools actually returned (not only in the prompt); coverage of a multi-part ask; injection compliance across a trajectory (untrusted content in a tool result reaching a later call or the answer); step and turn ceilings; verification auditing (did the agent check its own work); trace ingestion via OpenTelemetry GenAI semantic conventions.

### Track 3 -- Reach: make Iris usable from wherever your agents run

MCP is how Iris is discovered and how it is used interactively. It is not a guarantee of capture: under the protocol a tool call is always the model's decision, so anything that *must* be recorded needs a path that does not depend on the model choosing to call it.

- **Shipped.** `POST /api/v1/traces` ([docs/http-ingest.md](http-ingest.md)): the same contract as the `log_trace` tool, with optional deterministic evaluation on write, so a CI job, a service in another language, or plain `curl` can send traces without an MCP client. The Claude Code skill and plugin (`skills/iris-eval/`, `claude-plugin/`).
- **Not shipped.** Server-provided MCP `instructions` on initialize and a capabilities resource; a CLI for CI gates and batch evaluation; SDKs for guaranteed capture — the TypeScript LangChain wrapper in `packages/langchain/` is **unpublished** and LangChain agents should use HTTP ingest today; a batch ingest shape and a dedicated `POST /evaluations` route; datasets and run comparison, so evaluation becomes a regression workflow rather than a one-off score.

### Hosted and team features

**Status: Under consideration, not under construction.**

Shared team history, managed storage, alerting, retention policies, SSO/RBAC and audit export are all plausible additions, and the codebase is deliberately built so they can be added without disturbing the self-hosted path — tenant scoping already runs through every storage call, and the storage layer sits behind an adapter interface.

None of it is being built today, and no pricing exists. Two commitments hold regardless of what happens later: **nothing that is free today will move behind a paywall**, and **no compliance certification will be claimed before it is held**.

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
