# Reddit Post Drafts

---

## r/LocalLLaMA

### Title

Built the first MCP-native eval & observability tool for AI agents — open-source, self-hosted, SQLite-powered

### Body

I have been building AI agents for a few months and kept running into the same problem: once they are running, I have no visibility into what they are actually doing. Traditional monitoring shows HTTP status codes and latency, but it can't tell me if the agent's output was relevant, if it leaked PII, or if a specific tool call in the chain returned garbage.

So I built Iris. It is the first MCP-native eval and observability server for AI agents. It is an MCP server — not a library, not an SDK. Any MCP-compatible agent (Claude Desktop, Cursor, or anything built with the MCP SDK) discovers and uses it automatically. You add it to your MCP config and you are done.

What it does:

- **Self-hosted with SQLite.** Your data stays local. Traces are stored in a single SQLite file you can back up, move, or inspect with any SQLite tool.
- **No SDK integration.** Iris is a protocol-native MCP server. Your agent discovers it and calls its tools. No imports, no client code, no code changes.
- **12 built-in eval rules.** Detects PII (SSN, credit card, phone, email), prompt injection patterns (5 patterns), blocklisted content, cost overruns, hallucination markers, and more. Custom rules via Zod schemas.
- **See what your agents are costing you.** The dashboard aggregates cost across all your agents over any time window. Not just per-trace cost — total spend visibility.
- **Hierarchical span tree.** Trace exactly where in the agent execution chain things went wrong. See per-tool-call latency to find your bottleneck.
- **Dark-mode web dashboard.** Summary cards, trace list with filters, span tree view, eval scores with per-rule breakdown. Start with `--dashboard` flag.
- **Production security.** API key auth, rate limiting, helmet headers, CORS, input validation, ReDoS-safe regex.

Install:

```
npm install -g @iris-eval/mcp-server
iris-mcp --dashboard
```

TypeScript, MIT licensed, open-source core.

GitHub: https://github.com/iris-eval/mcp-server

Happy to answer questions about the architecture, the eval rule system, or the MCP integration approach.

---

## r/MachineLearning

### Title

[P] Iris: First MCP-native evaluation and observability tool for AI agents

### Body

Releasing Iris, an open-source MCP server for evaluating and monitoring AI agent outputs. The core problem: as agents move from demos to production, there is no standard way to automatically evaluate output quality across runs, track cost, or detect safety issues like PII leakage and prompt injection.

Iris is the first eval and observability tool built natively on the Model Context Protocol. It exposes nine MCP tools that any compatible agent discovers and calls automatically — no SDK integration required. Three core tools (log_trace / evaluate_output / get_traces), four lifecycle tools (list_rules / deploy_rule / delete_rule / delete_trace), and two semantic-eval tools (evaluate_with_llm_judge with 5 templates, verify_citations with SSRF-guarded source resolution).

**Evaluation framework:**

The engine supports 4 rule categories with 13 built-in rules:

- *Completeness:* min output length, non-empty check, sentence count, expected output coverage (keyword overlap ratio)
- *Relevance:* input-output keyword overlap, hallucination marker detection (hedging phrases like "as an AI", plus fabricated-citation heuristic), topic consistency scoring
- *Safety:* PII pattern matching (10 patterns: SSN, credit card, phone, email, IBAN, DOB, MRN, IPv4, API key, passport), prompt injection detection (13 output-side compliance patterns), stub/placeholder detection (TODO/FIXME/etc.), configurable blocklist
- *Cost:* USD threshold check, output-to-input token ratio efficiency

Each rule returns a score [0, 1] and a pass/fail. Rules have weights. The engine computes a weighted average and compares against a configurable threshold (default 0.7). Custom rules are supported via Zod-validated definitions at evaluation time.

**Cost tracking and aggregation:**

Every trace records `token_usage` (prompt, completion, total) and `cost_usd`. The dashboard aggregates cost across all agents over configurable time windows — so you can answer "what did my agents cost me this week?" not just "what did this one trace cost?" The cost eval rules enforce per-execution budget thresholds and flag inefficient token usage patterns.

**Trace-level debugging:**

Iris captures hierarchical execution spans with OpenTelemetry-compatible span kinds. The dashboard renders these as a span tree, letting you trace exactly where in an agent's execution chain something failed or slowed down. Per-tool-call latency is tracked individually.

**Two eval tracks:** The 13 built-in rules are heuristic-based (regex, keyword overlap, token ratios) — fast (<1ms), deterministic, free. The new `evaluate_with_llm_judge` tool (v0.4) adds semantic scoring via Anthropic or OpenAI across five templates (accuracy / helpfulness / safety / correctness / faithfulness) with pessimistic per-eval cost cap. Pick the right tool for the question — heuristics for fast PII / injection / cost guardrails; LLM-judge for "did the output actually answer the user."

Stack: TypeScript, better-sqlite3, Express 5, @modelcontextprotocol/sdk. Self-hosted, SQLite storage, MIT licensed.

GitHub: https://github.com/iris-eval/mcp-server

Interested in feedback on the evaluation methodology — particularly the weighting scheme, threshold calibration, and what rule categories are missing. The safety rules are regex-based for now; would appreciate perspective on whether that's sufficient for production PII detection or if we need to go further.
