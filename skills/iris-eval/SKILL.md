---
name: iris-eval
description: Evaluate AI agent outputs for quality, safety, and cost using the Iris MCP server. Use when reviewing agent responses, checking for PII leaks, scoring output quality, or tracking execution costs.
allowed-tools: [Read, Write, Bash, Grep, Glob]
metadata:
  filePattern: ["**/mcp.json", "**/.well-known/mcp.json", "**/mcp-server*"]
  bashPattern: ["iris", "mcp-server", "evaluate", "eval"]
---

# Iris — The Agent Eval Standard for MCP

Iris is an MCP server that scores every agent output for quality, safety, and cost. 12 built-in deterministic eval rules. No LLM-as-judge. No SDK. No code changes.

## When to Use

- An agent returned output and you want to verify its quality
- You need to check agent responses for PII leaks (credit cards, SSNs, emails)
- You want to track per-execution costs and flag expensive runs
- You need to compare agent quality across different prompts or models
- You want automated eval rules running on every agent execution

## Quick Start

```bash
npx @iris-eval/mcp-server
```

Or add to your MCP config:

```json
{
  "mcpServers": {
    "iris": {
      "command": "npx",
      "args": ["-y", "@iris-eval/mcp-server"]
    }
  }
}
```

## Available Tools

### log_trace
Log an agent execution trace with spans, tool calls, and metrics.

**Use when:** You want to record what an agent did for later analysis.

### evaluate_output
Evaluate agent output quality using 12 built-in deterministic rules across 4 categories:
- **Completeness** — is the response thorough and relevant?
- **Relevance** — does the output address the prompt?
- **Safety** — PII detection, prompt injection patterns, hallucination markers
- **Cost** — token usage, execution cost, budget threshold checks

**Use when:** You want a quality score for any agent response.

### get_traces
Query stored traces with filters, pagination, and summary statistics.

**Use when:** You want to review past agent executions or track quality trends over time.

## How to Interpret Scores

- **Score 0.0 - 0.3:** Critical issues detected (PII leak, prompt injection, severe hallucination)
- **Score 0.3 - 0.7:** Quality concerns (incomplete response, relevance issues, cost overrun)
- **Score 0.7 - 1.0:** Good quality (all rules passing, within cost budget)

Each rule fires independently with a clear pass/fail result. No opaque LLM scoring — every score is deterministic and reproducible.

## 12 Built-in Eval Rules

| Category | Rule | What It Checks |
|----------|------|---------------|
| Completeness | topic_consistency | Output addresses the prompt topic |
| Completeness | response_complete | Response is substantive, not truncated |
| Completeness | expected_coverage | Key expected elements are present |
| Relevance | language_match | Output language matches input |
| Relevance | output_format_valid | Structured output matches expected schema |
| Relevance | sentiment_appropriate | Tone matches context |
| Safety | no_pii | No credit cards, SSNs, phone numbers, emails leaked |
| Safety | no_hallucination_markers | No fabricated citations, invented facts |
| Safety | no_injection_patterns | No prompt injection attempts in output |
| Safety | no_blocklist_words | No prohibited terms |
| Cost | cost_under_threshold | Execution cost within budget |
| Cost | latency_under_threshold | Response time within limits |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| IRIS_API_KEY | (none) | API key for HTTP transport auth |
| IRIS_DB_PATH | ./iris.db | SQLite database path |
| IRIS_LOG_LEVEL | info | Logging verbosity |
| IRIS_DASHBOARD | true | Enable real-time dashboard |
| IRIS_PORT | 3001 | Dashboard port |

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
- Glama: https://glama.ai/mcp/servers/iris-eval/mcp-server (AAA rated)
