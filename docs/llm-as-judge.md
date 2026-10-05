# LLM-as-Judge — Semantic Evaluation

Iris ships deterministic, rule-based evaluation by default — it's fast, free, and reproducible.
Some quality questions don't reduce to regex or keyword overlap, though. "Does this answer address
the question?" "Is this claim factually correct?" "Does this RAG output stay grounded in the
sources we gave the agent?" For those, Iris supports **LLM-as-Judge**: a single MCP tool
(`evaluate_with_llm_judge`) that calls an LLM to score the output and returns a 0..1
score with rationale, per-dimension breakdown, and exact cost. The score is a rubric-guided model
judgment, not a probability checked against labelled outcomes. How accurately it tracks ground-truth
labels — on an adversarial, clean and prompt-injection set — is measured by `npm run proof:judge`;
until a keyed run replaces the committed placeholder the number is pending. See
[`proof/judge/README.md`](../proof/judge/README.md), `proof/judge-results.json`, and the judge status
on https://iris-eval.com/proof beside the deterministic rules' numbers.

> **Bring your own key.** Iris doesn't proxy LLM calls, doesn't bundle credits, and doesn't have a hosted-judge tier. To use LLM-as-judge you set `IRIS_ANTHROPIC_API_KEY` or `IRIS_OPENAI_API_KEY` in your environment, and Iris calls the provider directly with your key. No third party in the loop. The deterministic eval rules (`evaluate_output`) need no key and cost nothing to run.

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

**Enable the LLM judge (optional; the deterministic rules never need it)**
1. Get an API key from Anthropic or OpenAI.
2. Put it in the environment of the process that runs Iris, not only your shell. Claude Code, Claude Desktop, Cursor and most MCP clients: the "env" block of the iris-eval entry in your MCP config — "iris-eval": { "command": "npx", "args": ["-y", "@iris-eval/mcp-server"], "env": { "IRIS_ANTHROPIC_API_KEY": "sk-ant-..." } } (IRIS_OPENAI_API_KEY for an OpenAI key). Docker: -e IRIS_ANTHROPIC_API_KEY=... on the run command. HTTP or CI: export it before starting iris-eval.
3. Restart the MCP session. A running process never sees a variable set after it started.
4. Confirm from inside your client: read iris://capabilities — judge.enabled must be true there. A key exported in your shell is not passed to the process your client spawns unless its config lists it. On a machine, `npx @iris-eval/mcp-server --self-test` prints the judge line for that shell, and GET /api/v1/health reports judge.enabled on a running dashboard.
5. Spend guard: each call is capped by IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL (default 0.25 USD) and refused before any spend if the worst case would exceed it. Every judge call Iris makes on your key draws on one daily budget, IRIS_LLM_JUDGE_DAILY_BUDGET_USD (default 1 USD per UTC day); past it, no call is made until midnight UTC. Iris calls the provider directly with your key and never proxies it.
6. Optional: set IRIS_RELEVANCE_JUDGE_MODEL to a priced model id (claude-haiku-4-5, for example) to have answers_the_ask ask the judge whether each answer addresses its ask, and fail an off-topic one. That is one judge call per evaluation that carries an input, on your key and under the cap above; the key alone never turns it on. Each call sends that input and output to the model's provider, with the personal data and credentials no_pii flags replaced first (IRIS_RELEVANCE_JUDGE_REDACT=off sends them as they are). It draws on that daily budget and makes at most IRIS_RELEVANCE_JUDGE_MAX_CALLS_PER_REQUEST calls per request (default 20); past either, answers_the_ask reads the ask lexically and says why.

### 2. Optional: set a stricter cost cap

```bash
# Default is $0.25 / eval. Lower it if your workload is high-volume.
export IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL=0.02
```

The cap is **pre-checked pessimistically** — Iris estimates worst-case cost (entire `max_output_tokens` billable at output rate, plus the one retry that fires if the judge's first reply is not valid JSON) and refuses the call if that would exceed the cap. You never get a surprise bill.

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
| `task_completed` | Did the task actually complete, or only read as if it had?    | `output`, `input`; the trajectory as `source_material` when you have it | 0.70           |
| `relevance`     | Does the output address THIS request, not another subject or question? | `output`, `input`                                              | 0.60           |

Dimensions returned (per template):

- `accuracy` → `factual_claims`, `citations`, `internal_consistency`
- `helpfulness` → `addresses_question`, `specificity`, `actionability`
- `safety` → `harm_potential`, `pii_leak`, `injection_compliance` (higher = safer)
- `correctness` → `semantic_match`, `missing_facts`, `added_errors`
- `faithfulness` → `source_grounding`, `invented_specifics`, `summarization_quality`
- `task_completed` → `parts_done`, `claims_supported`, `scope_kept`
- `relevance` → `addresses_request`, `on_subject`, `specific_to_request`

---

## The relevance judge behind `answers_the_ask`

`answers_the_ask` asks whether an output answers the ask it was given. Without a judge it compares words: it fires when both relevance measurements fail (fewer than 35% of the ask's content terms in the output, fewer than a third of its sentences connected to the ask), and on a bare refusal or the ask handed back. Comparing words fails correct answers that paraphrase, so at the shipped thresholds that reading **advises**: it is reported, the verdict's `interpretations` says why it did not decide, and an off-topic answer passes.

Set `IRIS_RELEVANCE_JUDGE_MODEL` to a priced model id, with that provider's key, and the rule asks the `relevance` template instead and **gates** on its verdict: an off-topic answer fails with `verdict.basis: "policy_gate"` and `verdict.by: ["answers_the_ask"]`.

```json
"env": {
  "IRIS_ANTHROPIC_API_KEY": "sk-ant-...",
  "IRIS_RELEVANCE_JUDGE_MODEL": "claude-haiku-4-5"
}
```

- **What it costs.** One judge call for each evaluation that runs `answers_the_ask` on a call carrying an input: `evaluate_output`, `log_trace` with `evaluate: true`, the HTTP ingest route, OTLP traces sent with `iris.evaluate: true`, `iris-eval ingest` and `evaluate_runs` alike, so every door gives a trace the same verdict. Each call is capped by `IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL` and refused before any spend if its worst case exceeds it. On the 36 cases in `proof/judge/cases/relevance.json`, the worst case of one judgment (two attempts, the full output cap billed) is $0.0060 on `claude-haiku-4-5-20251001` and $0.0008 on `gpt-4o-mini`, measured by `tests/unit/proof/relevance-judge-proof.test.ts`. The evaluation's spend is on the rule result as `judge.costUsd`.
- **What leaves your machine.** For each evaluation it judges, the judge sends two texts to the model's provider (Anthropic or OpenAI) over HTTPS, on your key, directly from the Iris process: the trace's `input` and its `output`, inside the `relevance` template's prompt. Nothing else from the trace is sent: not its tool calls, spans, metadata, cost or ids. Nothing is sent while `IRIS_RELEVANCE_JUDGE_MODEL` is unset, when a limit below stops the call, or for an evaluation with no input.
- **Personal data and credentials are redacted first, by default.** Before the call, every span Iris's own `no_pii` rule flags in either text (the SSN, card, phone, email, IBAN, passport, date-of-birth, medical-record and public-IP patterns, the API keys and tokens it knows, private key blocks, seed phrases, and any of those inside a base64 run) is replaced by a marker such as `[REDACTED:Email#1]`. It is the same detector the rule runs, not a second list. Markers are numbered per value across both texts, so an answer that repeats the address the ask gave carries the same marker, and the prompt tells the judge to read a marker as the value it replaced. `judge.redacted` counts what was replaced, per pattern (`{"Email": 2}`).
  - Why it is the default: relevance is about subject, not about the digits of a card number, so replacing a value with a labelled marker leaves the question the judge answers intact. Sending a secret Iris itself flags to a third party would be the leak the product exists to catch. The cost is an evaluation whose whole subject is a value the detector flags (an ask to "repeat the key back", say): the judge sees a marker, not the key.
  - The opt-out: `IRIS_RELEVANCE_JUDGE_REDACT=off` sends both texts as they are, and every judge record then carries `sentUnredacted: true`. Any other value keeps redaction on.
- **Spend limits.** The per-call cap bounds one judgment. Two more limits bound the total, and when either stops a call nothing is spent, the rule reads the ask lexically (it advises), and `judge.withheld` says which limit it was, with the sentence in `judge.error`:
  - `IRIS_LLM_JUDGE_DAILY_BUDGET_USD` (default `1`) is what every judge call together may spend per UTC day, per tenant: this judge's calls and those of `evaluate_with_llm_judge` and `verify_citations` draw on one balance, because one key pays for all three. It is kept in the database (table `relevance_judge_spend`, migration 017), so a restart, a second server on the same file and `iris-eval ingest` all draw on it too. Until 0.21.0 it was `IRIS_RELEVANCE_JUDGE_DAILY_BUDGET_USD` and covered this judge only; that name is still read when the new one is unset, and the server says so at startup. A call is made only if its worst case (the same two-attempt estimate the per-call cap uses) fits in what is left; that worst case is held while the call runs and replaced by the call's actual cost when it returns, so the day's total never passes the budget. A call that fails after the provider may have billed it stays counted at its worst case. `withheld: "daily_budget"`, and the first refusal of the day for a tenant writes one warning line to the server log (once per process). `0` stops every call. The budget resets at 00:00 UTC, the day the providers' usage pages report by. At the $0.0060 worst case above, the default admits at least 165 judgments a day, and more once calls settle to what they cost.
  - `IRIS_RELEVANCE_JUDGE_MAX_CALLS_PER_REQUEST` (default `20`) is how many judge calls one request may make. An OTLP request can carry 2,000 traces and `evaluate_runs` re-scores a whole run; each judges its first 20 and reads the rest lexically with `withheld: "request_cap"`. The OTLP answer's `iris-eval.relevance_judge` gives `calls`, `withheld` and `max_calls_per_request`, and the `evaluate_runs` summary says how many were withheld. `iris-eval ingest` is not one request: each trace it reads is its own, and the daily budget bounds a large file.
- **A key alone never turns it on.** The key enables `evaluate_with_llm_judge`, which you call and pay for per call. The model has to be named because cost varies a hundredfold across models, and so that a key set for the judge tool does not start billing every evaluation.
- **What the result carries.** `rule_results[answers_the_ask]` has `kind: "judgment"`, `role: "gate"`, the judge's `sample` evidence, and a `judge` object: `provider`, `model`, `score`, `passThreshold` (0.60), `passed`, `rationale`, `dimensions`, `costUsd`, tokens and latency. The verdict is the score against the pass line; the model's own `passed` is kept as `selfReportedPass` and never obeyed.
- **What it judges that the words cannot.** A paraphrase that shares none of the ask's words, a one-word answer, and an ask with a single content term are all judged, not skipped. A wrong answer to the question asked is relevant; correctness is another template's question.
- **When the judge cannot answer.** An unpriced model, a missing key, a cost-cap refusal, a spend limit or a provider error is recorded as `judge.error`. The rule then falls back to the lexical reading, which advises, and `interpretations` carries a warning naming the reason. A deployment that believes the judge is on never reads a lexical verdict as the judge's. A judge that is configured and cannot run at all (no key for its provider, or a model with no price) is also said at startup: the server and `iris-eval ingest` print one warning line naming what is missing, and `--self-test` fails its judge step instead of printing PASS, because every evaluation would otherwise fall back to a reading that only advises.
- **Same family.** When the linked trace records the agent's model (`metadata.model` or a span's `gen_ai.request.model`) and the judge shares its family, the verdict stands and `interpretations` carries the same-family warning `evaluate_with_llm_judge` returns.
- **Where to check.** `iris://capabilities` → `judge.relevance` says whether a relevance judge is configured and whether it can be called, what it sends (`egress`, `redact`), the per-request cap, and today's `budget` (`limitUsd`, `spentUsd`, `remainingUsd`, `calls`, `refused`, `exhausted`, `resetsAt`); `judge.dailyBudget` is the same balance, there whether or not a relevance judge is installed, since the judge tools draw on it too. `--self-test` prints the same line, with today's spend read from the install's database. `GET /api/v1/health` (and `/health` on the HTTP transport) carries `judge.relevance.budget_exhausted` and `budget_resets_at`, so a probe can alert when the judge stops for the day; it does not report the amount, since it answers without a key.
- **Tool annotations.** With a relevance judge installed, `evaluate_output`, `log_trace` and `evaluate_runs` advertise `openWorldHint: true`, and `evaluate_output` advertises `idempotentHint: false`: each call may reach the provider and spend again. Without one they stay closed-world. Annotations are read once, when the server registers its tools, which is after it installs the judge from the environment.
- **Replays.** A judge changes the ruleset hash, so `evaluate_runs` re-scores traces that were judged without it.
- **Embedders.** The engine calls no model unless you install one: `engine.setRelevanceJudge(createRelevanceJudge({ model, apiKey }))`, both exported from `@iris-eval/mcp-server/engine`. Redaction is on and the per-request cap applies there too. Without a `budget` option the daily budget is kept in the process's memory and resets when it exits; pass a `JudgeBudget` over your own ledger to keep it, and the same one to `engine.setJudgeBudget` so every judge call shares it.

How accurate the judge is, and how the judged rule compares with the lexical one on the rule's own 45 labelled cases, is measured by `npm run proof:judge` (see [the measurement](#measuring-the-relevance-judge) below). Until a keyed run is published, those numbers are pending.

### Measuring the relevance judge

`npm run proof:judge` measures the `relevance` template the way it measures every template: 36 labelled cases in `proof/judge/cases/relevance.json` (18 that must pass, 9 of them shaped to fool a word-matching reader: a paraphrase, a one-word answer, a query, a hedge, a clarifying question, a refusal that engages the request, a wrong answer to the right question; 12 violations; 6 injection twins that add an instruction to the judge), with precision, recall, Wilson intervals and the score drift the injections cause. In the same run it measures `answers_the_ask` with the judge installed, through the engine a deployment runs, on the rule's corpus family `proof/corpus/answers_the_ask.json`, beside the lexical rule on the same cases. It then runs the composite corpus through the shipped engine with the judge installed, and reports how often the whole verdict is right about shipping, the false and missed blocks, and which verdicts the judge moved, beside the same corpus without it (`proof/COMPOSITE.md`). Both need a key; the committed `proof/judge-results.json` says `pending` until a keyed run replaces it, and https://iris-eval.com/proof shows the same status.

What is measured without a key, on every CI run:

- the case file's rubric is whole lines of the shipped system prompt, so the labels were judged against the bar the judge is given;
- the worst-case cost above;
- the lexical `answers_the_ask` on the 36 relevance cases, the gap the judge exists to close: it fails 10 of the 18 cases that should fail and misses 8: two answers to a neighbouring question on the same subject, a drift, a keyword match on the wrong subject, a wrong ticket, two injection twins of those, and a placeholder too brief to measure. Of the 18 that should pass it wrongly fails 2 (a paraphrase and a hedged estimate) and cannot measure 4, which are too brief.

---

## Models + pricing

Iris carries a curated pricing table. Using an unknown model is an immediate error — the engine can't enforce the cost cap without pricing data.

Read from the providers' own pricing pages on 2026-09-28 (Anthropic: claude.com/pricing, and platform.claude.com/docs/en/about-claude/pricing for the cache columns; OpenAI: developers.openai.com/api/docs/pricing). This table is held to `src/eval/llm-judge/pricing.ts` by a test; edit the code, then this table, and the test says when they disagree.

The two cache columns price a trace's estimated cost ([cost.md](cost.md)), not a judge call. Anthropic's cache write is the 5-minute write (1.25 times the input price); the 1-hour write is 2 times, and is priced when the trace carries Anthropic's split of its writes, which Iris's wrappers send. The OpenAI models here charge nothing extra to write the cache, so their cache-write price is the input price: OpenAI's prompt-caching guide adds a write price only from GPT-5.6.

| Provider  | Model                            | Input $/1M | Output $/1M | Cache read $/1M | Cache write $/1M | 1h cache write $/1M | Notes                                                        |
|-----------|----------------------------------|------------|-------------|-----------------|------------------|---------------------|--------------------------------------------------------------|
| anthropic | claude-fable-5-1                 | 10.00      | 50.00       | 0.25            | 12.50            | 20.00               | Highest quality, dearest                                     |
| anthropic | claude-opus-5-5                  | 4.00       | 20.00       | 0.20            | 5.00             | 8.00                |                                                              |
| anthropic | claude-sonnet-5                  | 2.00       | 10.00       | 0.20            | 2.50             | 4.00                | Good default for production eval                             |
| anthropic | claude-haiku-4-5                 | 1.00       | 5.00        | 0.10            | 1.25             | 2.00                | Recommended for high volume                                  |
| anthropic | claude-haiku-4-5-20251001        | 1.00       | 5.00        | 0.10            | 1.25             | 2.00                | Same model, dated id                                         |
| anthropic | claude-opus-5                    | 5.00       | 25.00       | 0.50            | 6.25             | 10.00               | Legacy on the provider's page                                |
| anthropic | claude-opus-4-8                  | 5.00       | 25.00       | 0.50            | 6.25             | 10.00               |                                                              |
| anthropic | claude-opus-4-7                  | 5.00       | 25.00       | 0.50            | 6.25             | 10.00               | Was listed at 15/75 before 0.14.0; corrected (#478, Roy Tong) |
| anthropic | claude-opus-4-6                  | 5.00       | 25.00       | 0.50            | 6.25             | 10.00               |                                                              |
| anthropic | claude-sonnet-4-6                | 3.00       | 15.00       | 0.30            | 3.75             | 6.00                |                                                              |
| anthropic | claude-opus-4-5                  | 5.00       | 25.00       | 0.50            | 6.25             | 10.00               |                                                              |
| anthropic | claude-sonnet-4-5                | 3.00       | 15.00       | 0.30            | 3.75             | 6.00                |                                                              |
| openai    | gpt-5                            | 1.25       | 10.00       | 0.125           | 1.25             | —                   |                                                              |
| openai    | gpt-5-mini                       | 0.25       | 2.00        | 0.025           | 0.25             | —                   |                                                              |
| openai    | gpt-4.1-mini                     | 0.40       | 1.60        | 0.10            | 0.40             | —                   |                                                              |
| openai    | gpt-4o                           | 2.50       | 10.00       | 1.25            | 2.50             | —                   |                                                              |
| openai    | gpt-4o-mini                      | 0.15       | 0.60        | 0.075           | 0.15             | —                   | Cheapest option; lower fidelity                              |
| openai    | o4-mini                          | 1.10       | 4.40        | 0.275           | 1.10             | —                   | Reasoning model                                              |
| openai    | o3-mini                          | 1.10       | 4.40        | 0.55            | 1.10             | —                   | Reasoning model                                              |
| openai    | o1-mini                          | 1.10       | 4.40        | 0.55            | 1.10             | —                   | Retired 2026-09-20: absent from the provider's pricing page; price from its model page (read 2026-09-28), which was $3 / $12 here before 0.20.0 |

To add a new model: edit `src/eval/llm-judge/pricing.ts`, add the row here, add a CHANGELOG note. A model the provider stops pricing is marked retired, never deleted.

---

## Cost controls

Three layers, checked in order:

1. **Pre-call pessimistic estimate** — input chars ÷ 4 for tokens, full `max_output_tokens` billable, and the malformed-JSON retry (same prompt plus a short suffix, output capped at 256) priced on top. If the two-attempt worst case exceeds the cap, the call never fires.
2. **Provider-side limits** — rate limits (429) are retried once respecting `Retry-After`; a second 429 is a hard fail.
3. **Post-call actual cost** — returned in every response as `cost_usd`, computed from provider-reported `input_tokens` + `output_tokens` × pricing table, summed across both attempts when a retry ran. Stored on the eval result so the dashboard can show it.

Typical cost per call on a ~500-token output with haiku: **$0.0003–$0.0005**.
Same output with opus: **$0.015–$0.025**.

---

## A judge from the agent's own family

A judge that shares a model family with the agent it scores is not an independent reader: the two were trained on the same data with the same preferences, so the judge tends to forgive the agent's characteristic errors and reward its characteristic style. The measurement is not wrong, but it is narrower than it looks.

Since 0.14.0 the tool says so. When `trace_id` names a trace that records the agent's model (`metadata.model`, or a span's `gen_ai.request.model`), or when you pass `agent_model`, and that model shares a family with the judge's `model`, the response carries:

```json
"warnings": [{ "code": "IRIS_JUDGE_SAME_FAMILY", "message": "The judge (claude-haiku-4-5) shares a model family (claude) with the agent it judged (claude-opus-4-7). …" }]
```

The evaluation stands and is stored; nothing is refused — you may have no other key. Read it as a same-family opinion, or judge again with a model from another family. Families are read off the id's leading token (`claude`, `gpt`, the OpenAI o-series, `gemini`, `llama`, `mistral`, …); an id the tool does not recognise is never called "same".

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
- `rationale` carried as the rule result's `message`, which the dashboard shows beside the verdict
- `cost_usd` aggregated into the Drift view's cost treemap under the new "LLM Judge" category

They're stored under `eval_type='custom'` because LLM-judge spans all four heuristic categories (completeness/relevance/safety/cost); the custom bucket is the cleanest home.

---

## Design rationale

**Why a separate tool, not a flag on `evaluate_output`?**
Different operational shape. `evaluate_output` is in-process, free and deterministic. `evaluate_with_llm_judge` waits on a provider round-trip, costs money, and can fail for reasons `evaluate_output` never can (auth, rate limit, upstream outage). MCP annotations reflect this — `evaluate_output.readOnlyHint=false, openWorldHint=false` vs `evaluate_with_llm_judge.openWorldHint=true`. Agents should be able to reason about these differently before calling. The one exception is a deployment decision, not a per-call flag: `IRIS_RELEVANCE_JUDGE_MODEL` has `answers_the_ask` consult the relevance judge on every evaluation that carries an input. It is off unless the operator names a model, and the tool annotations describe the default.

**Why fetch() instead of the vendor SDKs?**
Supply-chain minimalism. The wire format is simple, the SDKs pull in dozens of transitive deps, and Iris's surface area is narrow enough that a hand-rolled fetch wrapper is 200 lines and auditable. When Anthropic or OpenAI ships new features we can't use (streaming, tool-use, vision), we'll reconsider — but for judge workloads, single-shot text-in / text-out is it.

**Why a pessimistic pre-check instead of letting the provider enforce?**
Providers enforce *their* limits — usage tier, per-key quota. Iris's cap is *user intent*: "don't let an agent accidentally burn $50 on one eval because the rubric got fed the full book". A budget guard that only triggers after the money is spent is not a guard.

**Why retry on malformed JSON?**
Base rates: good frontier models emit valid JSON ~97% of the time with explicit instructions. The 3% is almost always recoverable by adding "the previous response wasn't JSON — respond with only the object". One retry costs ~$0.0003 and recovers the call; two retries is diminishing returns and risks the cost cap being hit by the retries themselves. One retry is the right spot.

**Why `eval_type='custom'` instead of a new `'llm_judge'` type?**
Future work. Adding an `EvalType` value ripples through every storage query, filter, rule registry. The rule-results payload already carries enough provenance (`ruleName: llm_judge:<template>:<model>`) for the dashboard to filter + visualize the subset. When LLM-judge usage patterns stabilize (is it mostly RAG faithfulness? Mostly correctness on labeled datasets?), we'll graduate it to a first-class type with dedicated UI. Until then: custom bucket, provenance in rule_results, no schema ripple.
