# Iris Roadmap

Public roadmap for `@iris-eval/mcp-server`. Updated 2026-03-13.

---

## v0.1.0 -- Core MCP Server

**Status: Released**

The foundation: a working MCP server with trace logging, evaluation, and a web dashboard.

- **3 MCP tools**: `log_trace`, `evaluate_output`, `get_traces` with Zod-validated input schemas
- **Evaluation engine**: 12 built-in rules across 4 categories (completeness, relevance, safety, cost), weighted scoring with configurable threshold, custom rule support
- **SQLite storage**: single-file database via better-sqlite3, schema migrations, queryable trace and evaluation history
- **Web dashboard**: React-based dark-mode UI with summary cards, trace list, span tree view, and evaluation results (served via Express on port 6920)
- **Security hardening**: API key authentication, rate limiting (express-rate-limit), helmet security headers, CORS, input validation, ReDoS-safe regex, 1MB body limit
- **Dual transport**: stdio for local MCP clients (Claude Desktop, Cursor), HTTP for networked deployments

---

## v0.2.0 -- Cloud Tier

**Status: Planned**

Move from single-user SQLite to team-scale infrastructure.

- **PostgreSQL storage adapter**: drop-in replacement for SQLite, connection pooling, concurrent writes
- **Multi-tenancy**: workspace isolation, per-workspace database schemas or row-level security
- **Team dashboards**: shared views, dashboard links, team-level aggregate metrics
- **API key management**: create, rotate, and revoke API keys per workspace via dashboard UI
- **Data export**: CSV and JSON export of traces and evaluation results

---

## v0.3.0 -- Alerting, Retention, and Framework Integrations

**Status: Planned**

Automated notifications when agent quality degrades, plus SDK adapters for non-MCP frameworks.

- **Alert rules**: configurable conditions (e.g., average score drops below 0.6 over 1 hour, error rate exceeds 5%, cost per trace exceeds $0.50)
- **Webhook notifications**: POST alert payloads to any URL (Slack, PagerDuty, custom endpoints)
- **Email notifications**: SMTP integration for alert emails with summary and affected traces
- **Retention policies**: automatic trace deletion after configurable TTL (e.g., 30 days), storage usage tracking
- **Dashboard alert panel**: view active alerts, alert history, and configure rules from the UI
- **Framework integration packages**: SDK adapters that pipe framework events to Iris for teams not yet on MCP
  - `@iris-eval/langchain` — LangChain callback handler (scaffolded)
  - `@iris-eval/crewai` — CrewAI workflow tracing (scaffolded)
  - `@iris-eval/autogen` — AutoGen conversation tracing (scaffolded)

---

## v0.4.0 -- LLM-as-Judge and Interoperability

**Status: Planned**

Semantic evaluation and integration with the broader observability ecosystem.

- **LLM-as-judge evaluation**: use an LLM to score output quality on dimensions like accuracy, helpfulness, and safety (configurable model, prompt templates, cost controls)
- **OpenTelemetry trace export**: export Iris traces as OTel spans to Jaeger, Grafana Tempo, Datadog, or any OTel-compatible backend
- **Annotation API**: human-in-the-loop feedback -- annotate traces with ground truth, corrections, or quality labels via API and dashboard
- **Comparison mode**: side-by-side trace comparison for A/B testing different prompts, models, or agent configurations
- **Evaluation history**: track eval scores per rule over time, per agent, to detect regressions

---

## v0.5.0 -- Enterprise

**Status: Planned**

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
- **Custom rule marketplace**: community-contributed evaluation rules published as npm packages, discoverable via a registry
- **Plugin system**: extend Iris with plugins for custom storage adapters, notification channels, authentication providers, and dashboard widgets
- **Example agents**: reference implementations of agents with Iris observability baked in, covering common patterns (RAG, tool-use, multi-agent)
- **Contributing guide**: documentation for contributing rules, storage adapters, and dashboard components

---

## How to Influence the Roadmap

- Open an issue on [GitHub](https://github.com/iris-eval/mcp-server/issues) with a feature request
- Upvote existing feature requests with a thumbs-up reaction
- Join the discussion in pull requests and issues
- Contribute directly -- see [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines
