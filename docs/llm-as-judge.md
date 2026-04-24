# LLM-as-Judge — Semantic Evaluation

Iris ships deterministic, rule-based evaluation by default — it's fast, free, and reproducible.
Some quality questions don't reduce to regex or keyword overlap, though. "Does this answer address
the question?" "Is this claim factually correct?" "Does this RAG output stay grounded in the
sources we gave the agent?" For those, Iris supports **LLM-as-Judge**: a single MCP tool
(`evaluate_with_llm_judge`) that calls an LLM to score the output and returns a calibrated 0..1
score with rationale, per-dimension breakdown, and exact cost.

> **Bring your own key.** Iris doesn't proxy LLM calls, doesn't bundle credits, and doesn't have a hosted-judge tier. To use LLM-as-judge you set `IRIS_ANTHROPIC_API_KEY` or `IRIS_OPENAI_API_KEY` in your environment, and Iris calls the provider directly with your key. No third party in the loop. The deterministic eval rules (`evaluate_output`) need no key and stay free forever.

This guide is the operational reference. Design rationale is at the end.

---

## TL;DR

```ts
// From an MCP-connected agent
await callTool('evaluate_with_llm_judge', {
  output: 'The capital of France is Paris.',
  template: 'accuracy',
  model: 'claude-haiku-4-5-20251001',
  input: 'What is the capital of France?',
});
// →
// {
//   "score": 0.98,
//   "passed": true,
//   "rationale": "The output states a correct, verifiable fact. No hallucinations or invented citations.",
//   "dimensions": { "factual_claims": 1.0, "citations": 1.0, "internal_consistency": 0.95 },
//   "model": "claude-haiku-4-5-20251001",
//   "provider": "anthropic",
//   "template": "accuracy",
//   "input_tokens": 127,
//   "output_tokens": 48,
//   "cost_usd": 0.000367,
//   "latency_ms": 1240
// }
```

---

## Setup

### 1. Install an API key

```bash
# Anthropic (recommended default — lower latency, cheaper haiku tier, Iris is MCP-native)
export IRIS_ANTHROPIC_API_KEY=sk-ant-...

# OR OpenAI
export IRIS_OPENAI_API_KEY=sk-...
```

Keys are read at call time, not server start. A missing key fails only the specific
`evaluate_with_llm_judge` call that needs it — the rest of Iris keeps working.

### 2. Optional: set a stricter cost cap

```bash
# Default is $0.25 / eval. Lower it if your workload is high-volume.
export IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL=0.02
```

The cap is **pre-checked pessimistically** — Iris estimates worst-case cost (entire `max_output_tokens` billable at output rate) and refuses the call if that would exceed the cap. You never get a surprise bill.

---

## Templates

Each template is a (system, user) prompt pair tuned to elicit a single JSON verdict. Phrasing matters — templates are versioned and changes require CHANGELOG notes.

| Template        | Use when                                                       | Required args                                                           | Pass threshold |
|-----------------|----------------------------------------------------------------|-------------------------------------------------------------------------|----------------|
| `accuracy`      | Detect hallucinations, invented stats, fake citations          | `output`                                                                | 0.70           |
| `helpfulness`   | Score whether the output addresses the user's actual ask       | `output`, `input` (recommended)                                         | 0.70           |
| `safety`        | Harm-potential beyond heuristic PII/injection detection        | `output`                                                                | 0.90           |
| `correctness`   | Compare against a known-correct reference answer (labeled eval) | `output`, `expected`                                                    | 0.80           |
| `faithfulness`  | RAG grounding — does the output invent beyond the sources?     | `output`, `source_material`                                             | 0.80           |

Dimensions returned (per template):

- `accuracy` → `factual_claims`, `citations`, `internal_consistency`
- `helpfulness` → `addresses_question`, `specificity`, `actionability`
- `safety` → `harm_potential`, `pii_leak`, `injection_compliance` (higher = safer)
- `correctness` → `semantic_match`, `missing_facts`, `added_errors`
- `faithfulness` → `source_grounding`, `invented_specifics`, `summarization_quality`

---

## Models + pricing

Iris carries a curated pricing table. Using an unknown model is an immediate error — the engine can't enforce the cost cap without pricing data.

| Provider  | Model                            | Input $/1M | Output $/1M | Notes                           |
|-----------|----------------------------------|------------|-------------|---------------------------------|
| anthropic | claude-opus-4-7                  | 15.00      | 75.00       | Highest quality, slowest        |
| anthropic | claude-sonnet-4-6                | 3.00       | 15.00       | Good default for prod eval      |
| anthropic | claude-haiku-4-5-20251001        | 1.00       | 5.00        | Recommended for high-volume     |
| openai    | gpt-4o                           | 2.50       | 10.00       |                                 |
| openai    | gpt-4o-mini                      | 0.15       | 0.60        | Cheapest option; lower fidelity |
| openai    | o1-mini                          | 3.00       | 12.00       | Reasoning model                 |

To add a new model: edit `src/eval/llm-judge/pricing.ts`, add a CHANGELOG note.

---

## Cost controls

Three layers, checked in order:

1. **Pre-call pessimistic estimate** — input chars ÷ 4 for tokens, full `max_output_tokens` billable. If this exceeds the cap, the call never fires.
2. **Provider-side limits** — rate limits (429) are retried once respecting `Retry-After`; a second 429 is a hard fail.
3. **Post-call actual cost** — returned in every response as `cost_usd`, computed from provider-reported `input_tokens` + `output_tokens` × pricing table. Stored on the eval result so the dashboard can show it.

Typical cost per call on a ~500-token output with haiku: **$0.0003–$0.0005**.
Same output with opus: **$0.015–$0.025**.

---

## Failure modes

| Symptom                                      | What Iris does                                                                  | What you do                                                             |
|----------------------------------------------|---------------------------------------------------------------------------------|-------------------------------------------------------------------------|
| `Anthropic auth failed (401)`                | Throws `LLMJudgeError kind=auth` immediately                                    | Check `IRIS_ANTHROPIC_API_KEY` has a valid, live key                    |
| `Anthropic rate-limited (429)`               | Retries once using `Retry-After` header; throws `LLMJudgeError kind=rate_limit` on second fail | Raise rate limit with provider or throttle caller                       |
| `Request timed out after 60000ms`            | `LLMJudgeError kind=timeout`                                                    | Raise `timeout_ms` or pick a faster model                               |
| `Judge response was not valid JSON`          | Retries once with stricter system prompt (smaller max_output_tokens)            | If the retry also fails, inspect `raw_response_id` to pull provider logs |
| `Estimated max cost ... exceeds cap ...`     | Refuses upfront, never calls the API                                            | Raise `IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL` or shrink `max_output_tokens` |
| `Unknown model "xyz"`                        | Throws at argument validation                                                   | Add pricing to `src/eval/llm-judge/pricing.ts` + CHANGELOG              |

---

## Dashboard view

LLM-judge evals show up in the same tables as heuristic evals, with:

- `rule_results[0].ruleName` set to `llm_judge:<template>:<provider>/<model>`
- `rationale` surfaced in the suggestions column when `passed === false`
- `cost_usd` aggregated into the Drift view's cost treemap under the new "LLM Judge" category

They're stored under `eval_type='custom'` because LLM-judge spans all four heuristic categories (completeness/relevance/safety/cost); the custom bucket is the cleanest home.

---

## Design rationale

**Why a separate tool, not a flag on `evaluate_output`?**
Different operational shape. `evaluate_output` is 5-50ms, free, deterministic. `evaluate_with_llm_judge` takes 1-10 seconds, costs money, and can fail for reasons `evaluate_output` never can (auth, rate limit, upstream outage). MCP annotations reflect this — `evaluate_output.readOnlyHint=false, openWorldHint=false` vs `evaluate_with_llm_judge.openWorldHint=true`. Agents should be able to reason about these differently before calling.

**Why fetch() instead of the vendor SDKs?**
Supply-chain minimalism. The wire format is simple, the SDKs pull in dozens of transitive deps, and Iris's surface area is narrow enough that a hand-rolled fetch wrapper is 200 lines and auditable. When Anthropic or OpenAI ships new features we can't use (streaming, tool-use, vision), we'll reconsider — but for judge workloads, single-shot text-in / text-out is it.

**Why a pessimistic pre-check instead of letting the provider enforce?**
Providers enforce *their* limits — usage tier, per-key quota. Iris's cap is *user intent*: "don't let an agent accidentally burn $50 on one eval because the rubric got fed the full book". A budget guard that only triggers after the money is spent is not a guard.

**Why retry on malformed JSON?**
Base rates: good frontier models emit valid JSON ~97% of the time with explicit instructions. The 3% is almost always recoverable by adding "the previous response wasn't JSON — respond with only the object". One retry costs ~$0.0003 and recovers the call; two retries is diminishing returns and risks the cost cap being hit by the retries themselves. One retry is the right spot.

**Why `eval_type='custom'` instead of a new `'llm_judge'` type?**
Future work. Adding an `EvalType` value ripples through every storage query, filter, rule registry. The rule-results payload already carries enough provenance (`ruleName: llm_judge:<template>:<model>`) for the dashboard to filter + visualize the subset. When LLM-judge usage patterns stabilize (is it mostly RAG faithfulness? Mostly correctness on labeled datasets?), we'll graduate it to a first-class type with dedicated UI. Until then: custom bucket, provenance in rule_results, no schema ripple.
