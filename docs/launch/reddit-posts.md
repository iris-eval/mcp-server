# Reddit Post Drafts

---

## r/LocalLLaMA

### Title

Built an open-source observability tool for AI agents -- logs traces, evaluates output quality, self-hosted with SQLite

### Body

I have been building AI agents for a few months and kept running into the same problem: once they are deployed, I have no visibility into what they are actually doing. Traditional monitoring tools show me HTTP status codes and latency, but they can't tell me if the agent's output was relevant, if it leaked PII, or if a specific tool call in the chain returned garbage.

So I built Iris. It is an MCP server (Model Context Protocol) that gives your agent three tools: `log_trace` to record full execution traces with spans, tool calls, token usage, and cost; `evaluate_output` to score output quality against configurable rules; and `get_traces` to query your trace history with filters.

What makes it different from other observability tools:

- **Fully self-hosted.** Everything runs on your machine. Traces are stored in a local SQLite file. No data leaves your infrastructure.
- **No SDK integration.** Iris is an MCP server, not a library. Any MCP-compatible agent (Claude Desktop, Cursor, or anything built with the MCP SDK) discovers and uses it automatically. You add it to your MCP config and you are done.
- **12 built-in eval rules.** Detects PII (SSN, credit card, phone, email), prompt injection patterns, blocklisted content, cost overruns, hallucination markers, and more.
- **Dark-mode web dashboard.** Summary cards, trace list with filters, span tree view, evaluation scores. Start with `--dashboard` flag.

Install: `npm install -g @iris-eval/mcp-server`

The whole thing is TypeScript, MIT licensed, and the SQLite database is a single file you can back up, move, or inspect with any SQLite tool.

GitHub: https://github.com/iris-eval/mcp-server

Happy to answer questions about the architecture or the eval rule system.

---

## r/MachineLearning

### Title

[P] Iris: MCP-native evaluation and observability for AI agents

### Body

Releasing Iris, an open-source MCP server for evaluating and monitoring AI agent outputs. The core problem: as agents move from demos to production, there is no standard way to automatically evaluate output quality across runs, track cost, or detect safety issues.

Iris exposes three MCP tools that any compatible agent can call: trace logging, output evaluation, and trace querying. The evaluation engine is the main contribution.

**Evaluation framework:**

The engine supports 4 rule types (completeness, relevance, safety, cost) with 12 built-in rules:

- *Completeness:* min output length, non-empty check, sentence count, expected output coverage (keyword overlap ratio)
- *Relevance:* input-output keyword overlap, hallucination marker detection (hedging phrases like "as an AI"), topic consistency scoring
- *Safety:* PII pattern matching (SSN, credit card, phone, email via regex), prompt injection detection (5 injection patterns), configurable blocklist
- *Cost:* USD threshold check, output-to-input token ratio efficiency

Each rule returns a score [0, 1] and a pass/fail. Rules have weights. The engine computes a weighted average score and compares against a configurable threshold (default 0.7). Custom rules are supported via Zod-validated definitions passed at evaluation time.

**Cost tracking:** Every trace records `token_usage` (prompt, completion, total) and `cost_usd`. The cost eval rules let you set per-execution budget thresholds and flag inefficient token usage patterns.

**Limitations:** The current eval rules are heuristic-based (regex, keyword overlap, token ratios). They are fast and deterministic but do not capture semantic quality. LLM-as-judge evaluation is on the roadmap for v0.4.0.

Stack: TypeScript, better-sqlite3, Express 5, @modelcontextprotocol/sdk. Self-hosted, SQLite storage, MIT licensed.

GitHub: https://github.com/iris-eval/mcp-server

Interested in feedback on the evaluation methodology, particularly around the weighting scheme and threshold calibration.
