# Iris Architecture Guide

This document describes the internal architecture of Iris, the MCP-native agent evaluation and observability server. It is written for developers who want to understand how the system works, contribute to it, or build integrations on top of it.

---

## 1. System Overview

Iris is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that provides observability and evaluation capabilities for AI agents. It runs as a standalone process that any MCP-compatible client (Claude Desktop, an IDE plugin, a custom agent framework) can connect to over **stdio** or **HTTP**.

Iris exposes nine MCP tools — full rule + trace lifecycle + LLM-as-judge + semantic citation verification: `log_trace`, `evaluate_output`, `get_traces`, `list_rules`, `deploy_rule`, `delete_rule`, `delete_trace`, `evaluate_with_llm_judge`, `verify_citations`. It also exposes MCP resources (`dashboard-summary`, `trace-detail`), a best-effort OpenTelemetry trace exporter (OTLP/HTTP JSON to `IRIS_OTEL_ENDPOINT` when configured), and an optional REST API that powers a web dashboard.

```
+-------------------+        MCP (stdio or HTTP)        +-------------------+
|   MCP Client      | --------------------------------> |   Iris Server     |
| (Agent/IDE/CLI)   | <-------------------------------- |                   |
+-------------------+                                   +--------+----------+
                                                                 |
                                                        +--------v----------+
                                                        |   SQLite (WAL)    |
                                                        +--------+----------+
                                                                 |
                                                        +--------v----------+
                                                        |   Dashboard API   |
                                                        |   (Express REST)  |
                                                        +--------+----------+
                                                                 |
                                                        +--------v----------+
                                                        |   React Dashboard |
                                                        |   (Vite SPA)      |
                                                        +-------------------+
```

### Key design decisions

- **MCP-native**: Tools and resources are first-class MCP primitives, not a REST wrapper. Agents call `log_trace` and `evaluate_output` the same way they call any other MCP tool.
- **Single-process**: The MCP server, dashboard API server, and storage engine run in one Node.js process. No external databases, queues, or services required.
- **SQLite with WAL**: Write-ahead logging gives concurrent read access from the dashboard while the MCP server writes traces, with no lock contention.
- **Deterministic eval**: All evaluation rules are pure functions over text. No LLM calls in the eval pipeline -- scores are reproducible and free.

---

## 2. Request Flow

### Trace ingestion

```
MCP Client                    Iris MCP Server              SqliteAdapter
    |                              |                            |
    |-- log_trace({...}) --------->|                            |
    |                              | generateTraceId()          |
    |                              | generateSpanId() (per span)|
    |                              |                            |
    |                              |-- insertTrace(trace) ----->|
    |                              |   (INSERT traces row)      |
    |                              |   for each span:           |
    |                              |     insertSpan(span) ----->|
    |                              |     (INSERT spans row)     |
    |                              |                            |
    |<-- { trace_id, "stored" } ---|                            |
```

1. The MCP client calls `log_trace` with agent name, input/output, tool calls, spans, token usage, and cost.
2. The tool handler generates a 32-hex-char trace ID (16 random bytes) and optional 16-hex-char span IDs (8 random bytes).
3. The trace row is inserted into the `traces` table. Each span is inserted into the `spans` table with a foreign key back to the trace.
4. The client receives the `trace_id` for later reference.

### Evaluation

```
MCP Client                    Iris MCP Server    EvalEngine        SqliteAdapter
    |                              |                 |                   |
    |-- evaluate_output({...}) --->|                 |                   |
    |                              |-- evaluate() -->|                   |
    |                              |                 | getRulesForType() |
    |                              |                 | rule.evaluate()   |
    |                              |                 |   (per rule)      |
    |                              |                 | weighted average  |
    |                              |                 | pass/fail check   |
    |                              |<-- EvalResult --|                   |
    |                              |                                     |
    |                              |-- insertEvalResult(result) -------->|
    |                              |                                     |
    |<-- { id, score, passed,  ----|                                     |
    |      rule_results,           |                                     |
    |      suggestions }           |                                     |
```

1. The MCP client calls `evaluate_output` with the output text, eval type, and optionally the original input, expected output, cost, token usage, and custom rules.
2. The `EvalEngine` selects the appropriate rule set (or builds custom rules from definitions).
3. Each rule runs independently, returning a `{ passed, score, message }` result.
4. A weighted average score is computed. `passed` requires the score to meet the configured threshold (default: 0.7) AND no critical rule to have failed — a failing critical rule (`no_pii`, `no_injection_patterns`, `no_blocklist_words`, or a deployed rule with severity high/critical) forces `passed: false` regardless of the weighted score.
5. The result is persisted to `eval_results` and returned to the client.

### Dashboard data flow

```
Browser               Dashboard API (Express)          SqliteAdapter
   |                         |                              |
   |-- GET /api/v1/summary ->|                              |
   |                         |-- getDashboardSummary() ---->|
   |                         |   (aggregate SQL queries)    |
   |<-- JSON summary --------|                              |
   |                         |                              |
   |   (5s polling interval) |                              |
   |-- GET /api/v1/traces -->|                              |
   |                         |-- queryTraces() ------------>|
   |<-- JSON trace list -----|                              |
```

The React dashboard polls the REST API on per-view cadences: **FAST (3s)** for live tail and trace stream, **NORMAL (10s)** for trace lists / summary / health, **SLOW (30s)** for trends / audit / rules / filter options. Polling only fires when the browser tab is visible (`document.visibilityState === 'visible'`).

---

## 3. Component Architecture

```
src/
  index.ts              Entry point: CLI parsing, bootstrap, shutdown
  server.ts             Creates McpServer, wires EvalEngine + tools + resources
  config/
    defaults.ts         Default configuration values
    index.ts            Config loader: defaults -> file -> env vars -> CLI args
  tools/
    log-trace.ts        log_trace: ingest traces + spans
    evaluate-output.ts  evaluate_output: run the heuristic eval pipeline, store results
    get-traces.ts       get_traces: query traces with filters + pagination
    delete-trace.ts     delete_trace: remove a single trace
    list-rules.ts       list_rules: read the deployed custom-rule store
    deploy-rule.ts      deploy_rule: validate + persist a custom rule, append to audit log
    delete-rule.ts      delete_rule: remove a custom rule
    evaluate-with-llm-judge.ts  evaluate_with_llm_judge: semantic scoring (BYOK, cost-capped)
    verify-citations.ts verify_citations: resolve citations behind an SSRF guard + judge support
    index.ts            Registers all nine tools on the MCP server
  eval/
    engine.ts           EvalEngine class: orchestrates rules, computes scores
    rules/
      completeness.ts   4 rules: min_output_length, non_empty_output, sentence_count, expected_coverage
      relevance.ts      2 rules: keyword_overlap, topic_consistency
      safety.ts         5 rules: no_pii (19 patterns), no_blocklist_words, no_injection_patterns (37 patterns), no_stub_output, no_hallucination_markers (25 context-grounded signals)
      cost.ts           2 rules: cost_under_threshold, token_efficiency
      custom.ts         Factory for 8 custom rule types (regex, length, keywords, JSON, cost)
      index.ts          Rule registry by eval type
  storage/
    index.ts            Factory: creates storage adapter from config
    sqlite-adapter.ts   SQLite implementation of IStorageAdapter
    migrations/
      001-initial-schema.ts   Creates traces, spans, eval_results tables + indexes
      index.ts                Migration runner with tracking table
  transport/
    stdio.ts            Wraps MCP SDK StdioServerTransport
    http.ts             Express app with StreamableHTTPServerTransport + middleware
    index.ts            Barrel exports
  middleware/
    auth.ts             Bearer token auth with timing-safe comparison
    cors.ts             Origin allowlist with wildcard pattern matching
    rate-limit.ts       Separate rate limiters for API (100/min) and MCP (20/min)
    error-handler.ts    Centralized error handler (Zod, HTTP, 500s)
    index.ts            Barrel exports
  resources/
    dashboard-summary.ts  iris://dashboard/summary resource
    trace-detail.ts       iris://traces/{trace_id} resource
    index.ts              Registers all resources
  dashboard/
    server.ts           Express app for REST API + static file serving
    validation.ts       Zod schemas for query parameter validation
    routes/
      traces.ts         GET /api/v1/traces, GET /api/v1/traces/:id
      evaluations.ts    GET /api/v1/evaluations
      summary.ts        GET /api/v1/summary
      filters.ts        GET /api/v1/filters
      health.ts         GET /api/v1/health
      eval-stats.ts     GET /api/v1/eval-stats (+ /trend, /rules, /failures)
      moments.ts        GET /api/v1/moments — Decision Moment classification
      rules.ts          GET/POST/DELETE custom rules, POST rules/custom/preview
      audit.ts          GET /api/v1/audit — read of the append-only audit log
      preferences.ts    GET/PATCH /api/v1/preferences

    Note: since v0.5.0 traces can also be CREATED over HTTP — POST
    /api/v1/traces (traces.ts) takes the same body as the log_trace tool,
    validated against the same exported schema, and with evaluate:true it
    runs the deterministic engine and writes an eval_result too. That is
    the no-MCP-client capture path; see docs/http-ingest.md. It is served
    by the DASHBOARD server, so it requires --dashboard (the dashboard no
    longer starts implicitly with --transport http).
  types/
    config.ts           IrisConfig interface
    trace.ts            Trace, Span, TokenUsage, ToolCallRecord types
    eval.ts             EvalRule, EvalResult, EvalContext, CustomRuleDefinition types
    query.ts            IStorageAdapter interface, TraceQueryOptions, DashboardSummary
  utils/
    ids.ts              Trace ID (16 bytes hex), span ID (8 bytes hex), eval ID (UUIDv4)
    logger.ts           Pino logger writing to stderr (stdout reserved for stdio transport)

dashboard/              React SPA (separate Vite build)
  src/
    App.tsx             Router: /, /traces, /traces/:id, /evals
    api/
      client.ts         fetch wrapper for /api/v1/* endpoints
      hooks.ts          React hooks with polling (useTraces, useSummary, useEvals, etc.)
      types.ts          TypeScript types mirroring server-side types
    hooks/
      usePolling.ts     setInterval with visibility-aware polling
    components/
      layout/           Shell, Header, Sidebar
      dashboard/        SummaryCards, TracesPerHourChart, DashboardPage
      traces/           TraceListPage, TraceDetailPage, TraceTable, SpanTree, SpanDetail
      evals/            EvalListPage, EvalTable, EvalDetailCard, EvalFilters
      shared/           Badge, JsonViewer, DataTable, Pagination, ScoreBadge, etc.
```

### Startup sequence

1. `index.ts` parses CLI args with `node:util.parseArgs`.
2. `loadConfig()` deep-merges: defaults -> `~/.iris/config.json` -> `IRIS_*` env vars -> CLI args.
3. `createStorage()` instantiates `SqliteAdapter`, which calls `initialize()` to enable WAL mode, turn on foreign keys, and run pending migrations.
4. `createIrisServer()` creates the MCP `McpServer` instance, instantiates `EvalEngine` with the configured threshold, and registers all tools and resources.
5. Based on `config.transport.type`:
   - **stdio**: Creates `StdioServerTransport` and connects.
   - **http**: Creates an Express app with helmet, body parsing, auth, rate limiting, and error handling. Mounts the `StreamableHTTPServerTransport` at `/mcp` (POST, GET, DELETE). Starts listening.
6. If the dashboard is explicitly enabled (`--dashboard`, `IRIS_DASHBOARD=true`, or `dashboard.enabled` in config.json), a second Express app starts on the dashboard port (default: 6920) with the REST API and static file serving. It never starts implicitly — with `--transport http` and no dashboard flag, iris logs how to enable it (the `POST /api/v1/traces` ingest endpoint lives on the dashboard server).
7. SIGINT/SIGTERM handlers gracefully shut down HTTP servers (10s timeout) and close the database.

---

## 4. Evaluation Pipeline

### Rule categories

| Category        | Rules                                                        | Default Weights |
|-----------------|--------------------------------------------------------------|-----------------|
| `completeness`  | `min_output_length`, `non_empty_output`, `sentence_count`, `expected_coverage` | 1, 2, 0.5, 1.5 |
| `relevance`     | `keyword_overlap`, `topic_consistency`                       | 1, 1 |
| `safety`        | `no_pii`, `no_blocklist_words`, `no_injection_patterns`, `no_stub_output`, `no_hallucination_markers` | 2, 2, 2, 1.5, 1 |
| `cost`          | `cost_under_threshold`, `token_efficiency`                   | 1, 0.5 |
| `custom`        | Dynamically built from `CustomRuleDefinition` array          | User-defined |

### Scoring algorithm

```
score  = SUM(rule[i].score * rule[i].weight) / SUM(rule[i].weight)   # evaluated rules only
passed = score >= threshold AND no critical rule failed              (default threshold: 0.7)
```

Each rule returns a score between 0 and 1. The final score is the weighted average across the rules that actually ran, rounded to three decimal places.

**`score` and `passed` answer different questions.** `score` is a quality gradient; `passed` is the ship/no-ship verdict. A failing (non-skipped) **critical** rule forces `passed: false` regardless of how high the weighted score is, and the response names the culprits in `critical_failures`. The critical rules are `no_pii`, `no_injection_patterns` and `no_blocklist_words`, plus any deployed custom rule with severity `high`/`critical`. A leaked SSN scores 0.765 against a 0.7 threshold and still fails — that is the point (see §Scoring semantics in `docs/api-reference.md`).

**Skipped rules are excluded, not scored 1.** A rule that cannot judge the output — `expected_coverage` with no expected output, a missing-context relevance rule, or a regex killed at the sandbox matching budget — returns `score: 0` with `skipped: true` and a `skipReason`, and is left OUT of both the weighted average and the critical-rule veto. A skipped rule therefore neither deflates the score nor vetoes on evidence it never gathered; budget-killed rules additionally carry `budgetExceeded: true` so a gate that must fail closed can treat them as failures.

### Built-in rule details

**Completeness rules:**
- `non_empty_output` (weight 2) -- Binary: 1 if non-whitespace content, 0 otherwise.
- `min_output_length` (weight 1) -- Score degrades linearly: `min(length / minLength, 0.99)`.
- `sentence_count` (weight 0.5) -- Splits on `[.!?]+`, counts non-empty segments.
- `expected_coverage` (weight 1.5) -- Tokenizes expected and output into words (>2 chars), computes set overlap ratio. Pass threshold: 50%.

**Relevance rules:**
- `keyword_overlap` (weight 1) -- Measures input-word presence in output. Score: `min(ratio * 2, 1)`. Pass threshold: 20% overlap.
- `topic_consistency` (weight 1) -- Measures what fraction of output words (>3 chars) also appear in the input. Score: `min(ratio * 5, 1)`. Pass threshold: 5%. Skips brief output (< 6 words ≥ 4 chars) to avoid false-positives.

**Safety rules (all weight 2):**
- `no_pii` -- Regex detection for 19 PII patterns (SSN, credit card, phone, email, IBAN, US passport, date-of-birth, medical record number, IPv4 address, API key heuristics, AWS access keys, Slack tokens, SendGrid keys, GitHub tokens, Google API keys, npm tokens, DigitalOcean tokens, PEM private-key blocks, BIP39 seed phrases). Documentation placeholders (example.com addresses, 555 numbers, published test cards, masked keys) are suppressed per match. Binary pass/fail.
- `no_blocklist_words` -- Checks output against a configurable blocklist. Binary pass/fail.
- `no_injection_patterns` -- Regex patterns for 37 prompt injection attempts in two tiers. Phrase tier (13): "ignore previous instructions", "disregard previous", "act/behave/respond as a/an", "pretend you are/to be", "override instructions/safety", "reveal/show/tell system prompt", "jailbroken", "forget all/everything/previous" -- suppressed inside quoted spans, so text that DISCUSSES injection is not flagged. Structural tier (24): imperatives hidden in HTML comments, forged system/orchestrator lines, smuggled JSON directive keys, retrieved-document framing addressed to the agent, base64 decode-and-execute, role reassignment. Output is also matched after obfuscation normalization (NFKC, zero-width strip, leetspeak fold). Binary pass/fail.
- `no_stub_output` -- Detects placeholder/stub markers as whole uppercase words (TODO, FIXME, PLACEHOLDER, XXX, TBD, HACK, NOT YET IMPLEMENTED, [INSERT, [ADD), plus marker-free stub shapes: content omitted for brevity, empty pass-only bodies, comment-described behaviour, always-true guards, self-satisfying tests. Markers removed by a diff, or named in prose ("contains a TODO"), do not count. Configurable via `customConfig.stub_markers`. Binary pass/fail.
- `no_hallucination_markers` (weight 1) -- Context-grounded hallucination detection: 25 signals that cross-check the output's specific claims against the caller-provided `input` (fabricated citations/attributions, contradictions with the source's booleans, tables, dates, times, statuses, versions, and totals; false-success claims). Two self-consistency checks (inconsistent totals, the fabricated-citation shape) also run without input; the context-grounded signals stay silent when no input is provided. Each detected signal subtracts 0.3 from the score. (Rewritten in v0.5.0 — the old 17-phrase hedging-marker list lived in the relevance bundle and caught zero real hallucinations.)

**Cost rules:**
- `cost_under_threshold` (weight 1) -- Configurable USD threshold (default: $0.10). Score degrades proportionally above threshold.
- `token_efficiency` (weight 0.5) -- Checks completion/prompt token ratio against a max (default: 5x). Skipped if no token data.

### Custom rule types

When `eval_type` is `custom`, rules are built from `CustomRuleDefinition` objects:

| Type                 | Config keys            | Behavior |
|----------------------|------------------------|----------|
| `regex_match`        | `pattern`, `flags`     | Output must match the regex |
| `regex_no_match`     | `pattern`, `flags`     | Output must NOT match the regex |
| `min_length`         | `length`               | Output char length >= value |
| `max_length`         | `length`               | Output char length <= value |
| `contains_keywords`  | `keywords`, `threshold` | Fraction of keywords present >= threshold |
| `excludes_keywords`  | `keywords`             | None of the keywords present |
| `json_schema`        | (none)                 | Output must be valid JSON |
| `cost_threshold`     | `max_cost`             | Cost USD <= max_cost |

Regex rules are protected against ReDoS in two layers, and only the second one is a boundary:

1. **Static checks (fast rejection, not a guarantee).** Pattern length is capped at 1000 characters, syntax is validated by compiling once, and `safe-regex2` rejects patterns it recognises as catastrophic. `safe-regex2` is a star-height heuristic — it does not catch everything, and `(a|a)*$` passes it while being exponential. `deploy_rule` and the dashboard composer additionally probe the candidate against short adversarial payloads inside the sandbox (50ms on a ≤128-char input) before persisting it.
2. **The runtime sandbox deadline (the actual boundary).** Every match of a user-supplied pattern runs in a worker thread under a hard 100ms budget. A match still backtracking at the deadline is terminated mid-execution and the rule reports `skipped: true` with `budgetExceeded: true`, so it neither passes nor deflates the weighted score. A per-evaluation circuit breaker opens after 3 breaches: remaining regex rules in that evaluation skip without running, bounding one hostile request regardless of how many regex rules it carries.

This is **fail-open per rule** by design — see [Custom Rules § ReDoS protection](./custom-rules.md#redos-protection) for the trade-off and how a fail-closed gate consumes `budgetExceeded`.

### Extending the eval engine

The `EvalEngine.registerRule(evalType, rule)` method allows programmatic registration of additional rules at runtime:

```typescript
evalEngine.registerRule('completeness', {
  name: 'my_custom_check',
  description: 'Checks for specific output structure',
  evalType: 'completeness',
  weight: 1,
  evaluate(context: EvalContext): EvalRuleResult {
    const passed = context.output.startsWith('{');
    return { ruleName: 'my_custom_check', passed, score: passed ? 1 : 0, message: '...' };
  },
});
```

Registered rules are appended to the built-in set for that eval type and included in all future evaluations.

---

## 5. Storage Design

### SQLite configuration

- **WAL mode** (`PRAGMA journal_mode = WAL`): Allows concurrent readers while a single writer operates. The dashboard API reads while MCP tools write.
- **Foreign keys enabled** (`PRAGMA foreign_keys = ON`): Ensures span and eval_result integrity.
- **Database path**: Default `~/.iris/iris.db`. Configurable via `--db-path`, `IRIS_DB_PATH`, or config file.

### Schema

Every data table carries a `tenant_id TEXT NOT NULL DEFAULT 'local'` column (added in migration 004, v0.4.0). OSS single-node deployments only ever see `'local'`; the column means shared or hosted storage could be added later without a painful data migration. No such deployment exists today. See §8 for the four-layer defense-in-depth enforcement.

```sql
-- Traces: one row per agent execution
CREATE TABLE traces (
    trace_id    TEXT PRIMARY KEY,          -- 32-char hex (16 random bytes)
    tenant_id   TEXT NOT NULL DEFAULT 'local',  -- added migration 004
    agent_name  TEXT NOT NULL,
    framework   TEXT,
    input       TEXT,
    output      TEXT,
    tool_calls  TEXT,                      -- JSON array of ToolCallRecord
    latency_ms  REAL,
    token_usage TEXT,                      -- JSON: { prompt_tokens, completion_tokens, total_tokens }
    cost_usd    REAL,
    metadata    TEXT,                      -- JSON: arbitrary key-value pairs
    timestamp   TEXT NOT NULL,             -- ISO 8601, provided by client or generated
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Spans: detailed execution breakdown within a trace
CREATE TABLE spans (
    span_id         TEXT PRIMARY KEY,      -- 16-char hex (8 random bytes)
    tenant_id       TEXT NOT NULL DEFAULT 'local',  -- added migration 004
    trace_id        TEXT NOT NULL REFERENCES traces(trace_id) ON DELETE CASCADE,
    parent_span_id  TEXT,                  -- NULL for root spans
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'INTERNAL',  -- INTERNAL|SERVER|CLIENT|PRODUCER|CONSUMER|LLM|TOOL
    status_code     TEXT NOT NULL DEFAULT 'UNSET',     -- UNSET|OK|ERROR
    status_message  TEXT,
    start_time      TEXT NOT NULL,         -- ISO 8601
    end_time        TEXT,                  -- ISO 8601
    attributes      TEXT,                  -- JSON: span-level key-value pairs
    events          TEXT                   -- JSON array: [{ name, timestamp, attributes }]
);

-- Evaluation results: scored assessments of agent outputs
CREATE TABLE eval_results (
    id             TEXT PRIMARY KEY,       -- UUIDv4
    tenant_id      TEXT NOT NULL DEFAULT 'local',  -- added migration 004
    trace_id       TEXT REFERENCES traces(trace_id) ON DELETE SET NULL,
    eval_type      TEXT NOT NULL,          -- completeness|relevance|safety|cost|custom
    output_text    TEXT NOT NULL,
    expected_text  TEXT,
    score          REAL NOT NULL,          -- 0.0 to 1.0
    passed         INTEGER NOT NULL,       -- 0 or 1
    rule_results   TEXT,                   -- JSON array of { ruleName, passed, score, message }
    suggestions    TEXT,                   -- JSON array of strings
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Migration tracking
CREATE TABLE _iris_migrations (
    id          TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Indexes

All hot-path indexes are composite with `tenant_id` as the leading column so every query is filterable by tenant without a full-table scan. This matters both for correctness (the composite index enforces that the planner chooses a tenant-scoped read path) and for Cloud-tier performance at scale.

| Index | Table | Column(s) | Purpose |
|-------|-------|-----------|---------|
| `idx_traces_tenant_timestamp` | traces | (tenant_id, timestamp) | Tenant-scoped time-range queries |
| `idx_traces_tenant_agent` | traces | (tenant_id, agent_name) | Tenant-scoped agent filtering |
| `idx_traces_tenant_framework` | traces | (tenant_id, framework) | Tenant-scoped framework filtering |
| `idx_spans_tenant_trace` | spans | (tenant_id, trace_id) | Tenant-scoped span lookup |
| `idx_spans_parent` | spans | parent_span_id | Span tree traversal |
| `idx_eval_results_tenant_trace` | eval_results | (tenant_id, trace_id) | Tenant-scoped eval lookup |
| `idx_eval_results_tenant_type` | eval_results | (tenant_id, eval_type) | Tenant-scoped eval type filter |
| `idx_eval_results_tenant_created` | eval_results | (tenant_id, created_at) | Tenant-scoped trend queries |

### Retention

The `IStorageAdapter` interface exposes `deleteTracesOlderThan(days)` which deletes traces older than the configured retention period (default: 30 days). Cascading deletes on spans are handled by the `ON DELETE CASCADE` foreign key constraint. Eval results linked to deleted traces have their `trace_id` set to `NULL` via `ON DELETE SET NULL`.

### Migration system

Migrations are tracked in the `_iris_migrations` table. Each migration has a string ID (e.g., `001-initial-schema`) and an `up()` function. On startup, the migration runner:

1. Creates `_iris_migrations` if it doesn't exist.
2. Reads the set of already-applied migration IDs.
3. For each unapplied migration, runs `up()` and records the ID inside a transaction.

New migrations are added as files in `src/storage/migrations/` and registered in the `migrations` array.

Migration history (as of v0.4.0):

| ID | Version | Purpose |
|----|---------|---------|
| `001-initial-schema` | v0.1.0 | Core tables + indexes |
| `002-eval-skip-fields` | v0.2.0 | `rule_results.skipped` + `skipReason` |
| `003-eval-passed-index` | v0.3.0 | Pass-rate query index |
| `004-tenant-id` | v0.4.0 | `tenant_id` column + composite indexes on all data tables. Upgrading from v0.3.x backfills every existing row with `tenant_id = 'local'` — see `tests/unit/storage/migration-tenant.test.ts` for the smoke test that proves no data loss. |

---

## 6. Transport Modes

### stdio (default)

```
MCP Client Process                 Iris Process
       |                                |
       |  stdin  (JSON-RPC request) --> |
       | <-- stdout (JSON-RPC response) |
       |                                |
       |      stderr (log output) ----> (terminal/file)
```

- Uses `@modelcontextprotocol/sdk`'s `StdioServerTransport`.
- No network exposure. No authentication needed.
- Logging goes to stderr via Pino (fd 2) to avoid corrupting the MCP protocol on stdout.
- Best for: local development, IDE integrations (Claude Desktop, VS Code), single-agent setups.
- The dashboard is still available when `--dashboard` is passed. It starts a separate HTTP server on port 6920.

### HTTP (Streamable HTTP)

```
MCP Client (remote)            Iris HTTP Server (Express)
       |                                |
       | POST /mcp  (JSON-RPC) -------> |  (auth + rate limit)
       | <--- 200 JSON-RPC response --- |
       |                                |
       | GET /mcp  (SSE streaming) ---> |  (long-lived connection)
       | <--- Server-Sent Events ------ |
       |                                |
       | DELETE /mcp (session end) ----> |  (auth + rate limit)
       | <--- 200 -------------------- |
```

- Uses `@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport`.
- Each connection gets a random UUID session ID.
- Express middleware stack: `helmet` -> `express.json` (with size limit) -> auth -> rate limiting -> error handler.
- Security headers set by Helmet (no CSP since it's API-only).
- Best for: multi-agent environments, remote agents, CI/CD pipelines, shared team servers.

### Configuration

| Setting | CLI | Env var | Default |
|---------|-----|---------|---------|
| Transport type | `--transport http` | `IRIS_TRANSPORT=http` | `stdio` |
| HTTP port | `--port 3000` | `IRIS_PORT=3000` | `3000` |
| HTTP bind address | (config file) | `IRIS_HOST=127.0.0.1` | `127.0.0.1` |
| Dashboard port | `--dashboard-port 6920` | `IRIS_DASHBOARD_PORT=6920` | `6920` |
| Dashboard bind address | `--dashboard-host <host>` | `IRIS_DASHBOARD_HOST=127.0.0.1` | `127.0.0.1` |
| API key | `--api-key <key>` | `IRIS_API_KEY=<key>` | (none) |

Both HTTP surfaces bind to loopback by default — nothing is reachable from the network until you deliberately change the bind address. When you do, and no API key is set, the server warns: an unauthenticated non-loopback bind accepts writes from anyone who can route to it.

The dashboard is off by default on both transports — enable it explicitly with `--dashboard` (or `IRIS_DASHBOARD=true`). It runs on its own port (default: 6920), and the `POST /api/v1/traces` HTTP ingest endpoint is served by it, so ingest also requires `--dashboard`.

---

## 7. Dashboard Architecture

The dashboard is a React SPA built with Vite, served as static files by the dashboard Express server.

### Server side

The dashboard API server (`src/dashboard/server.ts`) is a separate Express application from the MCP HTTP transport. It serves:

- **REST API** at `/api/v1/*` with rate limiting (600 req/min), CORS, auth, and Zod-validated query parameters.
- **Static files** from `dist/dashboard/` (the built React app).
- **SPA fallback** -- all non-API routes serve `index.html` for client-side routing.

API endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/health` | GET | Server health + storage status + uptime |
| `/api/v1/summary` | GET | Aggregate stats: trace count, avg latency, total cost, error rate, eval pass rate, traces/hour, top agents |
| `/api/v1/traces` | GET | Paginated trace list with filters (agent, framework, time range) and sorting |
| `/api/v1/traces/:id` | GET | Full trace detail with spans and eval results |
| `/api/v1/evaluations` | GET | Paginated eval results with filters (type, passed, time range) |
| `/api/v1/filters` | GET | Distinct agent names and frameworks for filter dropdowns |

### Client side

```
App.tsx
  |
  +-- BrowserRouter
        |
        +-- Shell (Header + Sidebar + content area)
              |
              +-- Route /           -> DashboardPage
              |                        +-- SummaryCards (traces, latency, cost, error rate, eval pass rate)
              |                        +-- TracesPerHourChart
              |
              +-- Route /traces     -> TraceListPage
              |                        +-- TraceFilters (agent, framework, time range)
              |                        +-- TraceTable
              |                        +-- Pagination
              |
              +-- Route /traces/:id -> TraceDetailPage
              |                        +-- Trace metadata
              |                        +-- SpanTree -> SpanRow -> SpanDetail
              |                        +-- ToolCallCard (per tool call)
              |                        +-- EvalDetailCard (per linked eval)
              |
              +-- Route /evals      -> EvalListPage
                                       +-- EvalFilters (type, passed)
                                       +-- EvalTable
                                       +-- Pagination
```

### Data fetching pattern

All API communication uses a shared `useApiData<T>` hook:

1. On mount, calls the API fetcher function.
2. Optionally sets up polling via `usePolling` (a `setInterval` wrapper that only fires when the tab is visible).
3. Returns `{ data, loading, error, refetch }`.

Polling intervals (per-view cadence introduced in v0.4):
- **FAST (3 seconds)**: live tail, trace stream
- **NORMAL (10 seconds)**: trace list, summary, health
- **SLOW (30 seconds)**: trends, audit, rules, filter options
- Trace detail: **no polling** (one-time fetch)

The `api` client module wraps `fetch()` and builds URLs relative to the page origin at `/api/v1/*`, making it work regardless of host/port configuration.

---

## 8. Security Model

### Defense layers

```
Request
  |
  v
[Helmet]           Security headers (X-Frame-Options, HSTS, X-Content-Type-Options, etc.)
  |
  v
[Body parser]      Request size limit (default: 1MB) -- prevents memory exhaustion
  |
  v
[CORS]             Origin allowlist with wildcard patterns (default: http://localhost:*)
  |                Preflight (OPTIONS) returns 204 with cached headers (86400s max-age)
  v
[Auth]             Bearer token in Authorization header
  |                Timing-safe comparison (crypto.timingSafeEqual) prevents timing attacks
  |                Health endpoints bypass auth
  v
[Rate limiting]    Two separate limiters:
  |                  - MCP endpoint: 20 requests/min (POST + DELETE /mcp only, not GET/SSE)
  |                  - Dashboard API: 600 requests/min (all /api/v1/* routes)
  |                Uses draft-7 standard headers (RateLimit, RateLimit-Policy)
  v
[Zod validation]   All tool inputs and API query params validated with Zod schemas
  |                Invalid requests return 400 with structured error details
  v
[ReDoS protection] Boundary: every user-regex match runs in a sandbox WORKER under a
  |                hard 100ms deadline; a match still backtracking at the deadline is
  |                killed and the rule reports skipped + budgetExceeded (fail-open)
  |                Circuit breaker: 3 breaches per evaluation -> remaining regex rules skip
  |                Fast-path rejection only (NOT the boundary): 1000-char cap, syntax
  |                compile, safe-regex2 (star-height heuristic — misses (a|a)*$)
  v
[Error handler]    Centralized handler: Zod errors -> 400, known errors -> status code,
                   unknown errors -> 500 with generic message (stack only in development)
```

### Auth configuration

- **stdio mode**: No auth needed -- the transport is local IPC.
- **HTTP mode without API key**: Iris logs a warning. All endpoints are open. Suitable for local development only.
- **HTTP mode with API key**: Set via `--api-key`, `IRIS_API_KEY`, or config file. All requests except `/health` require `Authorization: Bearer <key>`. Comparison uses `timingSafeEqual` to prevent timing side-channels.

### CORS

The `createCorsMiddleware` function accepts an allowlist of origin patterns. Wildcards (`*`) in patterns are converted to regex `.*`. The default pattern `http://localhost:*` matches any localhost port. The `Vary: Origin` header is set to ensure correct proxy/CDN caching.

### Input validation

- **MCP tool inputs**: Validated by Zod schemas registered with `server.registerTool()`. Invalid inputs are rejected by the MCP SDK before the handler runs.
- **Dashboard API query params**: Validated by Zod schemas in `src/dashboard/validation.ts`. Limits: pagination max 1000 rows, summary max 8760 hours (1 year).
- **Custom eval rules**: static checks (1000-char cap, syntax compile in a try/catch, `safe-regex2`) reject obvious offenders early, but the enforced boundary is the sandbox worker — user patterns never `.test()` on the main thread, and every match runs under a hard 100ms deadline with a 3-breach-per-evaluation circuit breaker.

### Tenant isolation (defense-in-depth)

OSS single-node deployments run with a single implicit tenant (`LOCAL_TENANT = 'local'`). The same code path enforces tenant isolation end-to-end, so any future multi-tenant deployment would inherit those boundaries rather than needing them retrofitted. Four independent layers prevent cross-tenant data leakage:

1. **Type system** — `TenantId` is a branded type in `src/types/tenant.ts`. The `IStorageAdapter` interface requires `tenantId: TenantId` as the **first** parameter of every read and write. A developer who forgets to pass tenant context gets a compile error, not a runtime bug.
2. **Runtime guard** — every adapter method calls `assertTenant(tenantId)` which throws `TenantContextRequiredError` if the value is missing, empty, or not a valid `TenantId`. This protects against type erasure (JSON parses, `any` casts) at integration boundaries.
3. **SQL scope** — every `SELECT`, `INSERT`, `UPDATE`, and `DELETE` carries an explicit `WHERE tenant_id = ?` clause (reads) or `VALUES (..., ?, ...)` bind (writes). There is no "get all traces" query path — only "get traces for tenant X."
4. **Composite indexes** — every hot-path index is `(tenant_id, <other columns>)`. This ensures the query planner physically scans only within a tenant's rows, and makes cross-tenant scans both correct *and* fast in a multi-tenant deployment.

Additional guards:

- **Resolver middleware** (`src/middleware/tenant.ts`) attaches `req.tenantId` to every Express request after auth. Route handlers pull tenant context from the request — they cannot be called with `undefined`.
- **Audit log** (`~/.iris/audit.log`) entries carry a `tenantId` field so rule deploys/deletes are attributable in a multi-tenant future.
- **Never trust client-provided tenant IDs**: in Cloud mode the tenant is resolved server-side from the auth token's claims, never from a query parameter or header. OSS mode hardcodes `LOCAL_TENANT`.

Regression coverage: `tests/unit/storage/sqlite-adapter.test.ts` includes explicit cross-tenant isolation assertions (tenant A writes are invisible to tenant B reads), and `tests/unit/storage/migration-tenant.test.ts` proves legacy v0.3 rows are backfilled to `LOCAL_TENANT` without leaking to other tenants.

### Supply-chain integrity

The release pipeline (`.github/workflows/release.yml`) produces and publishes:

- **npm provenance**: `npm publish --provenance` attaches a GitHub-signed attestation linking the tarball to the source commit and workflow run. Verified via `npm audit signatures`.
- **SPDX SBOMs**: Per-tag SBOMs for both the npm package and the Docker image, attached as GitHub release assets (`iris-npm-sbom.spdx.json` and `iris-docker-sbom.spdx.json`).
- **Cosign keyless signatures**: The Docker image is signed with Sigstore cosign using the workflow's GitHub OIDC identity. No long-lived signing key is managed. Verify with:

  ```bash
  cosign verify ghcr.io/iris-eval/mcp-server:vX.Y.Z \
    --certificate-identity-regexp='https://github.com/iris-eval/mcp-server' \
    --certificate-oidc-issuer='https://token.actions.githubusercontent.com'
  ```

- **Build-provenance attestations**: Both artifacts carry GitHub-signed `attest-build-provenance` attestations (SLSA v1 provenance). Inspect with `gh attestation verify` or `cosign verify-attestation`.

---

## 9. Extension Points

### Custom eval rules (available now)

The `evaluate_output` tool accepts a `custom_rules` array at call time:

```json
{
  "output": "The answer is 42.",
  "eval_type": "custom",
  "custom_rules": [
    {
      "name": "must_contain_number",
      "type": "regex_match",
      "config": { "pattern": "\\d+" },
      "weight": 2
    },
    {
      "name": "not_too_long",
      "type": "max_length",
      "config": { "length": 500 },
      "weight": 1
    }
  ]
}
```

Eight rule types are supported (see section 4). Weights control relative importance in the final score.

### Programmatic rule registration

If you import Iris as a library (rather than running it as a CLI), you can register rules on the `EvalEngine` instance:

```typescript
import { createIrisServer } from 'iris-mcp/server';
import { createStorage } from 'iris-mcp/storage';

const storage = createStorage(config);
const { evalEngine } = createIrisServer(config, storage);

evalEngine.registerRule('safety', {
  name: 'no_internal_urls',
  description: 'Output must not contain internal URLs',
  evalType: 'safety',
  weight: 2,
  evaluate(context) {
    const hasInternal = /https?:\/\/internal\./.test(context.output);
    return {
      ruleName: 'no_internal_urls',
      passed: !hasInternal,
      score: hasInternal ? 0 : 1,
      message: hasInternal ? 'Internal URL detected' : 'No internal URLs found',
    };
  },
});
```

These rules persist for the lifetime of the process and are combined with the built-in rules for the specified eval type.

### Storage adapters (future)

The `IStorageAdapter` interface (`src/types/query.ts`) defines the contract that any storage backend must implement. Currently only `SqliteAdapter` exists, but the factory pattern in `src/storage/index.ts` is designed for additional backends:

```typescript
export function createStorage(config: IrisConfig): IStorageAdapter {
  switch (config.storage.type) {
    case 'sqlite':
      return new SqliteAdapter(config.storage.path);
    // Future: case 'postgres': return new PostgresAdapter(config.storage.connectionString);
    default:
      throw new Error(`Unsupported storage type: ${config.storage.type}`);
  }
}
```

The interface covers lifecycle (initialize, close), trace and span CRUD, eval-result CRUD, dashboard and eval-stats aggregation, retention cleanup, and distinct-value queries. Every data method takes a `tenantId` as its first parameter.

### MCP resources

Two MCP resources are registered for direct agent access to data:

- `iris://dashboard/summary` -- Returns the same aggregate stats as `/api/v1/summary`. Useful for agents that want to self-monitor.
- `iris://traces/{trace_id}` -- Returns full trace detail with spans and eval results. Useful for agents that want to inspect their own past executions.

### Configuration layering

Configuration is loaded in four layers, each overriding the previous:

```
defaults.ts -> ~/.iris/config.json -> IRIS_* env vars -> CLI args
```

This allows base configuration in a file, environment-specific overrides in env vars, and per-invocation overrides on the command line.

---

## 10. Tool Description Template (Glama TDQS 5/5 contract)

Every MCP tool registered by Iris must follow this 7-section description template plus all 4 MCP annotations. The structure is enforced by `tests/integration/mcp-protocol.test.ts` (round-trip assertions on every tool). Drift fails CI.

### Why this exists

Glama indexes MCP servers and scores tool definitions on six dimensions (Tool Definition Quality Score — TDQS). The server-level TDQS is computed as **60% mean + 40% min** across per-tool scores, so a single weak tool drags the entire grade. The dimensions and weights:

| Dimension | Weight | What scores 5/5 |
|---|---|---|
| Purpose Clarity | 25% | Verb + resource clear; explicitly differentiated from sibling tools |
| Usage Guidelines | 20% | "Use when…" + "Don't use when…" with sibling-aware alternatives |
| Behavioral Transparency | 20% | All 4 MCP annotations + Behavior paragraph (side effects, auth, rate limits, timing) |
| Parameter Semantics | 15% | Schema covers structure; description adds cross-parameter intent (required-when, override behavior, defaults with rationale) |
| Conciseness & Structure | 10% | Single front-loaded opener; no wasted words |
| Contextual Completeness | 10% | Output shape (concrete JSON example) + Error modes (failure conditions) |

Tier cutoffs: A ≥3.5, B ≥3.0, C ≥2.0. **Iris targets pure 5/5 on every dimension on every tool.** Anything below 5/5 is a regression.

### The 7-section template

```typescript
server.registerTool(
  'tool_name',
  {
    title: 'Tool Title',
    description: [
      // 1. PURPOSE OPENER — single concise sentence, front-loaded with verb + resource.
      //    No wasted words. Conciseness 5/5 lives here.
      'Verb the resource and produce concrete result type.',
      '',
      // 2. SIBLING CONTRAST — explicit reference to ≥2 sibling tools and the
      //    contrast that picks this one. Purpose Clarity 5/5.
      'Sibling tools — toolA does X, toolB does Y. This tool is the Z PATH for ...',
      '',
      // 3. BEHAVIOR — side effects (read-only / writes / destructive in plain prose),
      //    auth requirements, rate limits, tenant scope, timing expectations.
      //    Behavioral Transparency 5/5 (alongside the 4 MCP annotations below).
      'Behavior. Writes/Reads/Calls X. Auth: Y. Rate-limited to Z. Runs in Wms.',
      '',
      // 4. OUTPUT SHAPE — concrete JSON schema example with field names + types.
      //    Contextual Completeness 5/5.
      'Output shape. Returns JSON: `{ "field": type, ... }`.',
      '',
      // 5. USE WHEN — specific positive conditions; mention prerequisites + which
      //    sibling to use otherwise. Usage Guidelines 5/5.
      'Use when ... [specific positive conditions, naming siblings].',
      '',
      // 6. DON'T USE WHEN — specific anti-conditions; mention better-fit sibling.
      "Don't use when ... [specific anti-conditions, naming better fit].",
      '',
      // 7. PARAMETERS — cross-parameter semantics: required-when, override behavior,
      //    default rationale, range constraints. Goes BEYOND what Zod schemas say.
      //    Parameter Semantics 5/5.
      'Parameters. paramA is REQUIRED when paramB="x" (else ignored). paramC overrides paramD. Defaults: paramE=N (rationale).',
      '',
      // 8. ERROR MODES — specific error conditions, status codes, recovery hints.
      //    Reinforces Contextual Completeness.
      'Error modes. Throws on X (Zod). Returns 400 on Y. Returns 429 on rate-limit. Storage failures propagate as 500.',
    ].join('\n'),
    inputSchema,
    annotations: {
      // All 4 must be set explicitly. Behavioral Transparency 5/5 anchor.
      readOnlyHint: false,      // true if no writes / no mutations
      destructiveHint: false,   // true if removes data
      idempotentHint: false,    // true if same inputs → same outputs always
      openWorldHint: false,     // true if calls external services / spends money
    },
  },
  handler,
);
```

### Per-parameter Zod descriptions

Every parameter in `inputSchema` must have `.describe()` of substance — minimum **20 characters** (enforced by CI). The text should explain INTENT beyond what the type signature already says:

```typescript
// ❌ Insufficient — just restates the field name
limit: z.number().default(50).describe('Results per page'),

// ✅ Adds intent the schema can't express
limit: z.number().default(50).describe('Results per page (default 50, max 1000 — values >1000 return 400)'),
```

### CI enforcement

`tests/integration/mcp-protocol.test.ts` enforces:

1. **Tool registration** — exact list of tool names + count assertion. Adding/removing tools requires updating the test (intentional).
2. **MCP annotations** — every tool must carry all 4 annotations with explicit values. Each tool's expected annotations are pinned in the test (no `any`, no missing).
3. **Description sections** — every tool description must contain: `Behavior`, `Output shape`, `Use when`, `Don't use`, `Parameters`, `Error modes`. Section names are checked verbatim.
4. **Sibling contrast** — every tool description must reference ≥2 sibling tool names. Catches the "purpose statement doesn't differentiate from siblings" failure mode.
5. **Zod description substance** — every parameter's `.describe()` must be ≥20 chars. Catches the "schema does the heavy lifting; description adds nothing" failure mode.

Run: `npm run test:integration` from the repo root.

### When adding a new tool

1. Copy the 7-section template above.
2. Wire it into `src/tools/index.ts` (`registerAllTools`).
3. Add the tool's expected annotations to the `expectations` map in `mcp-protocol.test.ts`.
4. Add the tool's name to the `allToolNames` arrays in the description-coverage and sibling-contrast tests.
5. Update `iris://dashboard/summary` resource if relevant.
6. Run `npm run test:integration` — CI gates are strict.
7. Update `docs/api-reference.md` with the new tool's reference page.

### When updating an existing tool

Never weaken a description. The template sections are non-negotiable; tightening within a section (e.g., shorter Behavior paragraph) is fine if the content stays comprehensive. Removing a section will fail CI.

### Glama re-scoring after changes

Glama re-pulls tool descriptions only when **Build & Release** is triggered in their admin (`glama.ai/mcp/servers/iris-eval/mcp-server/admin/dockerfile`). Daily `Sync Server` refresh handles GitHub metadata (license, commits, releases) but NOT tool descriptions. After any tool description change, trigger a fresh Build & Release to refresh the Glama TDQS scores.
