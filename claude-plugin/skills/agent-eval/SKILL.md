---
name: agent-eval
description: Evaluate AI agent output quality, safety, and cost using the Iris MCP server. Use when building, testing, or shipping agents and the user wants to score output quality, detect PII or prompt injection, verify citations, track cost per query, enforce cost budgets, add tracing/observability to an agent, or set up eval-driven development. Also use when the user asks "is my agent good enough to ship" or wants quality gates on agent responses.
---

# Agent Eval with Iris

Iris is an MCP server for agent evaluation. If this plugin is installed, its
nine tools are already available — no setup needed. If the tools are missing,
the server starts with `npx -y @iris-eval/mcp-server` in any MCP client config.

## Core workflow (eval loop)

1. **Log** the agent execution: `log_trace` with spans, tool calls, token
   usage, and cost. This builds the record everything else reads.
2. **Score** the output: `evaluate_output` runs 13 built-in rules across
   completeness, relevance, safety (10 PII patterns, 13 injection patterns,
   17 hallucination markers), and cost. Heuristic, deterministic, free.
3. **Judge** semantically when heuristics aren't enough:
   `evaluate_with_llm_judge` (templates: accuracy, helpfulness, safety,
   correctness, faithfulness). Requires the user's own API key in
   `IRIS_ANTHROPIC_API_KEY` or `IRIS_OPENAI_API_KEY` — Iris never proxies.
4. **Verify citations** in research/RAG outputs: `verify_citations` extracts
   citations, fetches sources (SSRF-guarded, opt-in), and checks each claim.
5. **Inspect** history: `get_traces` with filters; costs aggregate across
   agents and time windows.

## Custom rules

`deploy_rule` registers a custom eval rule (Zod schema) that fires on every
matching `evaluate_output`. `list_rules` enumerates; `delete_rule` removes.
Use custom rules to encode product-specific quality bars — a required
disclaimer, banned phrases, output length bands, expected coverage terms.

## Patterns worth suggesting

- **Quality gate before ship**: evaluate representative outputs; treat any
  safety-rule failure as blocking. Cost rules catch budget regressions.
- **Eval-driven development**: write rules first (the quality spec), then
  iterate the agent until they pass — the eval loop is the test suite.
- **Regression tracking**: log traces in CI runs; compare score drift across
  versions to catch silent quality decay (eval drift).

## Notes

- Traces persist locally in SQLite (`~/.iris/iris.db`) in self-hosted mode.
- Dashboard: `npx @iris-eval/mcp-server --dashboard` → http://localhost:6920.
- OpenTelemetry export: set `IRIS_OTEL_ENDPOINT` and `log_trace` also emits
  OTLP/HTTP to any collector.
- Full docs: https://iris-eval.com and https://iris-eval.com/llms-full.txt
