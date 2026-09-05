---
name: iris-eval
description: Evaluate AI agent outputs for quality, safety, and cost using the Iris MCP server. Use when reviewing agent responses, checking for PII leaks, scoring output quality, or tracking execution costs.
allowed-tools: [Read, Write, Bash, Grep, Glob]
metadata:
  filePattern: ["**/mcp.json", "**/.well-known/mcp.json", "**/mcp-server*"]
  bashPattern: ["iris", "mcp-server", "evaluate", "eval"]
---

<!--
  RENDERED FILE — do not edit the two SKILL.md files by hand.
  Source: skills/iris-eval/SKILL.template.md, rendered by
  scripts/claims/render-llms.mjs into skills/iris-eval/SKILL.md (the npm
  package) and claude-plugin/skills/agent-eval/SKILL.md (the plugin
  marketplace). Edit the template, run `npm run llms:render`, commit both.
  `npm run llms:check` fails CI when either file drifts from the render.
-->

# Iris — stop shipping agents on vibes

Iris is an MCP server for agent evaluation: it scores output quality, catches
safety failures, and enforces cost budgets. 9 MCP tools, 15 built-in
deterministic rules, optional LLM-as-judge (bring your own key). No SDK. No code changes.

Iris runs as an MCP server: add it to your client config (Quick Start below) or start it with `npx -y @iris-eval/mcp-server`.

## When to Use

- An agent returned output and you want to verify its quality
- You need to check agent responses for PII leaks (19 patterns: SSN, credit card, phone, email, IBAN, passport, DOB, medical record number, public IP address (loopback, private and documentation ranges are ignored), API key, and the modern credential class — AWS/Slack/SendGrid/GitHub/Google/npm/DigitalOcean tokens, PEM private-key blocks, seed phrases)
- You want to track per-execution costs and flag expensive runs
- You need to compare agent quality across different prompts or models
- You want eval rules that run on every execution the agent sends to Iris
- You need semantic judgment (LLM-as-judge) or citation verification on top of the heuristics

## Quick Start

```bash
npx @iris-eval/mcp-server
```

Or add to your MCP config:

```json
{
  "mcpServers": {
    "iris-eval": {
      "command": "npx",
      "args": ["-y", "@iris-eval/mcp-server"]
    }
  }
}
```

## Core workflow (the eval loop)

1. **Log** the agent execution: `log_trace` with spans, tool calls, token
   usage, and cost. This builds the record everything else reads.
2. **Score** the output: `evaluate_output`. Omit `eval_type` and every bundle
   runs; name one to narrow the run. Heuristic, deterministic, free. Pass
   `input` so the hallucination signals can cross-check the output against the
   material the agent was given, and `tool_calls` (or a `trace_id`) so the
   trajectory rules can judge what the agent did.
3. **Judge** semantically when heuristics aren't enough:
   `evaluate_with_llm_judge` (5 templates: accuracy, helpfulness, safety, correctness, faithfulness).
   Requires the user's own API key in `IRIS_ANTHROPIC_API_KEY` or
   `IRIS_OPENAI_API_KEY` — Iris never proxies. Without a key the tool says so
   and names the variable; the deterministic rules never need one.
4. **Verify citations** in research/RAG outputs: `verify_citations` extracts
   citations, fetches sources (SSRF-guarded, opt-in), and checks each claim.
5. **Inspect** history: `get_traces` with filters; costs aggregate across
   agents and time windows.

## The 9 tools

| Tool | What it does |
|------|--------------|
| `log_trace` | Record an agent execution — spans, tool calls, token usage, cost. Optional OTLP export via `IRIS_OTEL_ENDPOINT`. |
| `evaluate_output` | Score output against the built-in rules. `eval_type` defaults to `all` — every bundle runs (completeness \| relevance \| safety \| cost \| custom); pass one bundle name to score only that bundle. Heuristic, deterministic, free. |
| `get_traces` | Query stored traces with filters, pagination, time ranges. |
| `list_rules` | Enumerate deployed custom eval rules, plus the built-in roster: the criticality this server applies, and each rule's kind of claim, what it needs, the question it answers and the failure classes it names. |
| `deploy_rule` | Register a custom eval rule (Zod-validated) that fires on matching evaluations. |
| `delete_rule` | Remove a deployed custom rule, or disable / re-enable it. |
| `delete_trace` | Remove a single stored trace by ID. |
| `evaluate_with_llm_judge` | Semantic eval via LLM (Anthropic or OpenAI). 5 templates: accuracy, helpfulness, safety, correctness, faithfulness. Cost-capped, bring your own key — Iris never proxies. |
| `verify_citations` | Extract citations, fetch sources behind an SSRF-guarded resolver, judge whether each source supports the claim. |

## How to Read a Result

A result carries **two** fields that answer different questions. Read both.

| Field | What it is | How to use it |
|---|---|---|
| `score` | Weighted average across the rules that ran — a 0..1 **quality gradient**. | Trend it; compare prompts and models. Never read it alone as a safety signal. |
| `passed` | The **ship / no-ship verdict**: `score >= threshold` (default 0.7) **AND** no critical rule failed. | This is the field a gate branches on. |
| `critical_failures` | Names of the critical rules that failed. Present only when non-empty. | If present, the eval failed *because of these*, not because of the score. |
| `critical_skipped` | Critical rules that did not judge the output (e.g. a regex killed at the 100 ms sandbox budget, or a `cost_threshold` rule with no `cost_usd`). Present only when non-empty. | Treat as **unknown**, not clean, if you must fail closed. |
| `rule_results` | Per-rule `{ ruleName, passed, score, message, skipped?, skipReason?, critical, criticalSource }`. | Tells you exactly what tripped, and which rules could not judge. |
| `eval_type` | The bundle that actually ran. | Confirm you evaluated what you meant to. |

**A high score does not mean safe.** By default `no_pii`, `no_injection_patterns`
and `no_blocklist_words` are **critical**: when one fails, `passed` is forced to
`false` no matter how high the score is, and the rule is named in
`critical_failures`. The score is deliberately left untouched. Concretely,
output containing a real SSN scores about **0.765** — squarely in what a
score-only reading would call "good" — and still returns `passed: false`. Any
deployed custom rule with severity `high` or `critical` behaves the same way.
Which built-in rules are critical is a deployment setting; every rule result
carries the effective `critical` flag and `criticalSource`, and `list_rules`
reports the roster this server applies.

**`eval_type` defaults to `all`.** Omit it and every bundle runs — completeness,
relevance, safety, cost and any custom rules — with a per-bundle `categories`
map, and the response carries a `note` saying the default ran. A bundle with
nothing to judge (cost without `cost_usd`, relevance without `input`) reports
`passed: null` there — not evaluated, not failing. Name a bundle to narrow the
run, for example safety only:

```json
{ "output": "<agent text>", "eval_type": "safety", "input": "<the original ask>" }
```

Inline `custom_rules` are additive: they fire alongside whichever bundle
`eval_type` selected, in the same call and the same score. Pass
`eval_type: "custom"` to run only your rules.

So: branch on `passed`, read `critical_failures` to explain *why*, treat a
non-empty `critical_skipped` as unknown, and use `score` for trend and
comparison.

Each heuristic rule fires independently with a clear pass/fail result — every
score is deterministic and reproducible. LLM-judge scores are semantic and
carry the judge's reasoning.

## The 15 built-in eval rules

| Category | Rule | What It Checks |
|----------|------|---------------|
| Completeness | non_empty_output | Output isn't empty or whitespace-only |
| Completeness | min_output_length | Output meets a configurable minimum length |
| Completeness | sentence_count | Output contains complete sentences |
| Completeness | expected_coverage | Key expected elements are present |
| Relevance | keyword_overlap | Output vocabulary overlaps the input's |
| Relevance | topic_consistency | Output stays on the prompt's topic |
| Safety | no_pii | No PII leaked (19 patterns) — **critical by default: a failure hard-fails the whole eval** |
| Safety | no_injection_patterns | No prompt-injection attempts in the output (37 patterns) — **critical by default: a failure hard-fails the whole eval**. no_injection_patterns inspects the agent's OUTPUT text for injection-shaped content — attack phrasing and structural directives the output echoes or complies with — and never reads the input, so it is not an input firewall. |
| Safety | no_blocklist_words | No prohibited terms — **critical by default: a failure hard-fails the whole eval** |
| Safety | no_stub_output | No placeholder/stub markers (TODO, [INSERT, …) |
| Safety | no_hallucination_markers | No fabricated/contradicted claims vs the provided input (25 context-grounded signals) |
| Safety | no_silent_tool_failure | A tool call that failed is acknowledged, not answered over. Reads `tool_calls`; **skips** without them |
| Cost | cost_under_threshold | Execution cost within budget |
| Cost | token_efficiency | Token usage proportionate to the output |
| Cost | no_tool_loop | No tool called with the same input more than `max_tool_repeats` times (default 3). Reads `tool_calls`; **skips** without them |

How often each rule is right is measured and published, with intervals, at
https://iris-eval.com/proof.

## Custom rules

`deploy_rule` registers a custom eval rule that fires on every
`evaluate_output` of its `evalType`. `list_rules` enumerates; `delete_rule`
removes. A definition is `{ name, type, config, weight? }` where `type` is one
of `regex_match`, `regex_no_match`, `min_length`, `max_length`,
`contains_keywords`, `excludes_keywords`, `json_schema`, `cost_threshold`, and
`config` holds that type's keys (`pattern`/`flags`, `min_length`, `max_length`,
`keywords`/`threshold`, `max_cost`). Severity `high`/`critical` makes the rule
a hard veto; `low`/`medium` only affects the score. Use custom rules to encode
product-specific quality bars — a required disclaimer, banned phrases, output
length bands, a per-agent cost ceiling.

## Patterns worth suggesting

- **Quality gate before ship**: evaluate representative outputs with
  `eval_type: "safety"`; treat `passed: false` as blocking and a non-empty
  `critical_skipped` as unknown. Cost rules catch budget regressions.
- **Eval-driven development**: write rules first (the quality spec), then
  iterate the agent until they pass — the eval loop is the test suite.
- **Regression tracking**: log traces in CI runs; compare score drift across
  versions to catch silent quality decay (eval drift).
- **Capture that must not depend on the model**: the tools fire when the model
  calls them. For CI gates or services that must record every run, `POST
  /api/v1/traces` on the dashboard port (requires `--dashboard`) takes the same
  body as `log_trace` and can run the deterministic evals in the same request.

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| IRIS_HOME | ~/.iris | Directory for all per-user files: `config.json`, `iris.db`, `custom-rules.json`, `audit.log`, `preferences.json` |
| IRIS_API_KEY | (none) | API key for HTTP transport + dashboard auth |
| IRIS_DB_PATH | ~/.iris/iris.db | SQLite database path (overrides IRIS_HOME for the DB only) |
| IRIS_LOG_LEVEL | info | Logging verbosity |
| IRIS_DASHBOARD | (off) | Set `true` to enable the web dashboard (and with it `POST /api/v1/traces`) |
| IRIS_DASHBOARD_PORT | 6920 | Dashboard port |
| IRIS_OTEL_ENDPOINT | (none) | OTLP/HTTP collector for trace export |
| IRIS_ANTHROPIC_API_KEY / IRIS_OPENAI_API_KEY | (none) | Your own key for the LLM judge and citation verifier |
| IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL | 0.25 | Hard cost cap per LLM judge call |

## Example Workflows

Detailed walkthroughs with real engine output:
- [PII Detection](examples/pii-detection.md) — catch leaked personal data
- [Quality Scoring](examples/quality-scoring.md) — score output quality
- [Cost Tracking](examples/cost-tracking.md) — monitor per-execution costs

## Notes

- Traces persist locally in SQLite (`~/.iris/iris.db`); stored text is verbatim, including anything `no_pii` flags.
- Dashboard: `npx @iris-eval/mcp-server --dashboard` → http://localhost:6920. Demo data without wiring an agent: `--demo`.
- OpenTelemetry export: set `IRIS_OTEL_ENDPOINT` and `log_trace` also emits OTLP/HTTP to any collector.

## Links

- Website: https://iris-eval.com
- Playground: https://iris-eval.com/playground
- Measured rule accuracy: https://iris-eval.com/proof
- GitHub: https://github.com/iris-eval/mcp-server
- npm: https://npmjs.com/package/@iris-eval/mcp-server
- Full machine-readable reference: https://iris-eval.com/llms-full.txt
