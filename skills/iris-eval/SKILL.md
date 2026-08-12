---
name: iris-eval
description: Evaluate AI agent outputs for quality, safety, and cost using the Iris MCP server. Use when reviewing agent responses, checking for PII leaks, scoring output quality, or tracking execution costs.
allowed-tools: [Read, Write, Bash, Grep, Glob]
metadata:
  filePattern: ["**/mcp.json", "**/.well-known/mcp.json", "**/mcp-server*"]
  bashPattern: ["iris", "mcp-server", "evaluate", "eval"]
---

# Iris — The Agent Eval Standard for MCP

Iris is an MCP server for agent evaluation: it scores output quality, catches
safety failures, and enforces cost budgets. Nine MCP tools, 13 built-in
deterministic rules, optional LLM-as-judge (BYOK). No SDK. No code changes.

## When to Use

- An agent returned output and you want to verify its quality
- You need to check agent responses for PII leaks (10 patterns: SSN, credit card, phone, email, IBAN, passport, DOB, medical record number, IP address, API key)
- You want to track per-execution costs and flag expensive runs
- You need to compare agent quality across different prompts or models
- You want automated eval rules running on every agent execution
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

## The Nine Tools

| Tool | What it does |
|------|--------------|
| `log_trace` | Record an agent execution — spans, tool calls, token usage, cost. Optional OTLP export via `IRIS_OTEL_ENDPOINT`. |
| `evaluate_output` | Score output against the 13 built-in rules. Heuristic, deterministic, free. |
| `get_traces` | Query stored traces with filters, pagination, time ranges. |
| `list_rules` | Enumerate deployed custom eval rules. |
| `deploy_rule` | Register a custom eval rule (Zod-validated) that fires on matching evaluations. |
| `delete_rule` | Remove a deployed custom rule. |
| `delete_trace` | Remove a single stored trace by ID. |
| `evaluate_with_llm_judge` | Semantic eval via LLM (Anthropic or OpenAI). Five templates: accuracy, helpfulness, safety, correctness, faithfulness. Cost-capped, BYOK — Iris never proxies. |
| `verify_citations` | Extract citations, fetch sources behind an SSRF-guarded resolver, judge whether each source supports the claim. |

## How to Interpret Scores

- **Score 0.0 – 0.3:** Critical issues detected (PII leak, prompt injection, severe hallucination)
- **Score 0.3 – 0.7:** Quality concerns (incomplete response, relevance issues, cost overrun)
- **Score 0.7 – 1.0:** Good quality (all rules passing, within cost budget)

Each heuristic rule fires independently with a clear pass/fail result — every
score is deterministic and reproducible. LLM-judge scores are semantic and
carry the judge's reasoning.

## The 13 Built-in Eval Rules

| Category | Rule | What It Checks |
|----------|------|---------------|
| Completeness | non_empty_output | Output isn't empty or whitespace-only |
| Completeness | min_output_length | Output meets a configurable minimum length |
| Completeness | sentence_count | Output contains complete sentences |
| Completeness | expected_coverage | Key expected elements are present |
| Relevance | keyword_overlap | Output vocabulary overlaps the input's |
| Relevance | topic_consistency | Output stays on the prompt's topic |
| Safety | no_pii | No PII leaked (10 patterns) |
| Safety | no_injection_patterns | No prompt-injection attempts (13 patterns) |
| Safety | no_blocklist_words | No prohibited terms |
| Safety | no_stub_output | No placeholder/stub markers (TODO, [INSERT, …) |
| Safety | no_hallucination_markers | No fabricated/contradicted claims vs the provided input (25 context-grounded signals) |
| Cost | cost_under_threshold | Execution cost within budget |
| Cost | token_efficiency | Token usage proportionate to the output |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| IRIS_API_KEY | (none) | API key for HTTP transport auth |
| IRIS_DB_PATH | ~/.iris/iris.db | SQLite database path |
| IRIS_LOG_LEVEL | info | Logging verbosity |
| IRIS_DASHBOARD | (off) | Set `true` to enable the web dashboard |
| IRIS_DASHBOARD_PORT | 6920 | Dashboard port |
| IRIS_OTEL_ENDPOINT | (none) | OTLP/HTTP collector for trace export |
| IRIS_ANTHROPIC_API_KEY / IRIS_OPENAI_API_KEY | (none) | BYOK for the LLM judge |

## Example Workflows

See the `examples/` directory for detailed walkthroughs:
- [PII Detection](examples/pii-detection.md) — catch leaked personal data
- [Quality Scoring](examples/quality-scoring.md) — score output quality
- [Cost Tracking](examples/cost-tracking.md) — monitor per-execution costs

## Links

- Website: https://iris-eval.com
- Playground: https://iris-eval.com/playground
- GitHub: https://github.com/iris-eval/mcp-server
- npm: https://npmjs.com/package/@iris-eval/mcp-server
- Full machine-readable reference: https://iris-eval.com/llms-full.txt
