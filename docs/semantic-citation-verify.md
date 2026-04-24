# Semantic Citation Verification

When an AI agent writes output with citations — `[1]`, `https://arxiv.org/abs/...`,
`10.1038/nature05.001`, `(Smith, 2019)` — how do you know the cited sources actually
support the claims?

Iris ships a dedicated MCP tool (`verify_citations`) that runs the full pipeline:

1. **Extract** citations from the output (four recognized kinds)
2. **Resolve** URL and DOI citations by fetching the source, behind an SSRF-guarded resolver
3. **Verify** each (claim, source) pair with an LLM judge asking "does this source support this claim in context?"

It returns a per-citation verdict + an overall support ratio.

> **Bring your own key.** Same as `evaluate_with_llm_judge` — Iris uses your `IRIS_ANTHROPIC_API_KEY` or `IRIS_OPENAI_API_KEY` to call the LLM directly. No proxy, no hosted-judge tier, no bundled credits. Outbound HTTP for source-fetching is **also opt-in** via `allow_fetch=true` or `IRIS_CITATION_ALLOW_FETCH=1`.

---

## TL;DR

```ts
await callTool('verify_citations', {
  output: 'A 2019 Stanford study found 73% of users prefer dark mode [1]. See https://arxiv.org/abs/1234.5678 for methodology.',
  model: 'claude-haiku-4-5-20251001',
  allow_fetch: true,          // or set IRIS_CITATION_ALLOW_FETCH=1 globally
  domain_allowlist: ['arxiv.org', 'doi.org'],
});
// →
// {
//   "overall_score": 0.5,
//   "passed": true,     // 0.5 >= 0.5 threshold
//   "total_citations_found": 2,
//   "total_resolved": 1,     // [1] is unresolvable — no URL to fetch
//   "total_supported": 1,
//   "total_cost_usd": 0.000612,
//   "citations": [
//     { "citation": {"raw": "[1]", "kind": "numbered", ...}, "resolve_status": "skipped", "resolve_error": {"kind": "unresolvable_kind", ...} },
//     { "citation": {"raw": "https://arxiv.org/...", "kind": "url", ...}, "resolve_status": "ok", "source": {...}, "judge": {"supported": true, "confidence": 0.9, "rationale": "Source confirms the 73% figure in the abstract."} }
//   ]
// }
```

---

## Setup

### Enable outbound HTTP

Iris refuses to fetch anything by default. Two ways to enable:

```bash
# Environment-wide — off by default, set to 1 to enable
export IRIS_CITATION_ALLOW_FETCH=1
```

```ts
// Or per-call via the tool argument
callTool('verify_citations', { ..., allow_fetch: true });
```

### Lock down which hostnames you'll fetch from

```bash
# Env: comma-separated, suffix match. arxiv.org matches papers.arxiv.org too.
export IRIS_CITATION_DOMAINS=doi.org,arxiv.org,pubmed.ncbi.nlm.nih.gov,nature.com,science.org
```

```ts
// Or per-call, merged with env
callTool('verify_citations', { ..., domain_allowlist: ['openalex.org'] });
```

Empty allowlist + `allow_fetch=true` means Iris fetches **any public URL** (still SSRF-guarded). For production deployments we strongly recommend an explicit allowlist of sources you trust.

### Install an LLM judge key (shared with `evaluate_with_llm_judge`)

```bash
export IRIS_ANTHROPIC_API_KEY=sk-ant-...
# OR
export IRIS_OPENAI_API_KEY=sk-...
```

---

## Citation kinds

| Kind           | Example                      | Resolvable? | Notes                                          |
|----------------|------------------------------|-------------|------------------------------------------------|
| `numbered`     | `[1]`, `[27]`                | No          | Needs a footnote/bibliography Iris can't see   |
| `author_year`  | `(Smith, 2019)`              | No          | Needs a bibliography Iris can't see            |
| `url`          | `https://arxiv.org/abs/...`  | Yes         | Fetched via SSRF-guarded resolver              |
| `doi`          | `10.1038/nature05.001`       | Yes         | Normalized to `https://doi.org/<doi>` + fetched |

For the two unresolvable kinds, Iris reports them as `resolve_status: "skipped"` with
`resolve_error.kind: "unresolvable_kind"`. Future work could parse a bibliography block
out of the output and link numbered refs to it.

---

## SSRF defense layers (what Iris refuses, by default)

**Every fetch goes through this gauntlet:**

| Layer | What's blocked                                                              |
|-------|-----------------------------------------------------------------------------|
| 1     | Scheme: only `http:` / `https:` allowed (no `file:`, `data:`, `javascript:`) |
| 2     | Host: localhost, `127.0.0.0/8`, link-local `169.254.0.0/16` (incl AWS IMDS) |
| 2     | Host: RFC 1918 private ranges `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` |
| 2     | Host: IPv6 `::1`, `fc00::/7`, `fe80::/10`                                   |
| 2     | Host substrings: `localhost`, `.local`, `.internal`, `metadata.google*`, `metadata.azure*` |
| 3     | Optional: domain allowlist (when `IRIS_CITATION_DOMAINS` is set)            |
| 4     | Redirects: max 3 hops, every hop re-checked against layers 1-3              |
| 5     | Status: 4xx / 5xx reject; only 2xx advances to content extraction           |
| 6     | Content-type: text-like only (`text/*`, `xml`, `json`). Binaries rejected.  |
| 7     | Size: 5MB cap (configurable per call). Larger bodies truncate with a flag.  |
| 8     | Timeout: 10s per URL (configurable). Hard abort via AbortController.        |

Iris does **not** send cookies, authentication headers, or any identifying info beyond a
`user-agent: iris-mcp-citation-verifier/0.4 (+https://iris-eval.com)` header and a standard
`accept` list.

---

## Cost controls

Same structure as `evaluate_with_llm_judge`:

- **Per-call cost cap** — `max_cost_usd_total` (default $1.00). Budget across all judge calls in one `verify_citations` invocation. When the next call's pessimistic estimate would push total cost past the cap, the pipeline stops and reports `resolve_error.kind: "cost_cap_reached"` for remaining citations.
- **Per-citation pessimistic estimate** — before each judge call, worst-case cost is computed. If adding it exceeds the cap, skip.
- **Typical cost** — on haiku with 5 citations averaging 2KB source text: ~$0.002-$0.005 total. On opus with the same: ~$0.10-$0.25.

---

## Tuning knobs

| Argument                   | Default     | Notes                                                           |
|----------------------------|-------------|-----------------------------------------------------------------|
| `max_citations`            | 20          | Cap extraction count — protects against DoS-by-spam             |
| `max_cost_usd_total`       | 1.00        | Hard cost ceiling                                               |
| `per_source_timeout_ms`    | 10000       | Per-URL fetch timeout                                           |
| `per_source_max_bytes`     | 5_242_880   | Per-URL body cap (5MB)                                          |
| `allow_fetch`              | false       | Opt-in outbound HTTP (overrides env)                            |
| `domain_allowlist`         | null        | Merged with `IRIS_CITATION_DOMAINS`                             |

---

## Failure modes

| `resolve_error.kind`      | Meaning                                                                   |
|---------------------------|---------------------------------------------------------------------------|
| `unresolvable_kind`       | Numbered or author-year citation with no URL/DOI to fetch                 |
| `fetch_disabled`          | `allow_fetch=false` and `IRIS_CITATION_ALLOW_FETCH` not set               |
| `bad_scheme`              | Citation URL uses `file:` / `data:` / unusual scheme                      |
| `ssrf`                    | Hostname resolves to a private / localhost / cloud-metadata range         |
| `not_allowed_domain`      | Host not in configured allowlist                                          |
| `timeout`                 | Fetch exceeded `per_source_timeout_ms`                                    |
| `too_large`               | (rare — we truncate; only thrown on pathological streams)                 |
| `bad_status`              | 4xx/5xx response, or redirect with no Location header                     |
| `redirect_loop`           | More than `max_redirects` hops                                            |
| `not_text`                | Content-type is binary (PDF, octet-stream, etc.) — future work: PDF parse |
| `malformed_judge_response`| Judge didn't emit valid JSON even after retry                             |
| `llm_judge_error`         | Provider-side error (auth, rate limit, server error)                      |
| `cost_cap_reached`        | Budget exhausted; remaining citations skipped                             |

---

## Design rationale

**Why opt-in fetch?**
Arbitrary URL fetching based on LLM-generated content is an amplifier for any output-shaping attack. Even with SSRF guards, letting an agent trick Iris into fetching arbitrary endpoints is a bad default. Opt-in via flag + env keeps the operator in the loop.

**Why an LLM for the verify step instead of keyword matching?**
Citations support claims in context, not just by having matching keywords. "The capital of France is Paris [source]" with a source about the geography of Germany keyword-matches "capital" + "France" but does not support the claim. Only a semantic judge catches that; heuristics don't.

**Why a domain allowlist instead of just SSRF guard?**
SSRF guards block private hosts — they don't limit *which public hosts* an agent can trick Iris into fetching. Allowlist turns citation verification into "fetch from these 8 sources I trust", which is the safer default for production. Leaving it open is supported but discouraged.

**Why `10.5555/x.y.z` as the DOI floor in tests?**
Real DOI registrant codes are a minimum of 4 digits per the ISO DOI specification. Accepting 1-3 digits would cause false positives on version strings like "Node 10.1/foo" or "run 10.2 of the experiment". 4-digit minimum is the conservative cut-off.

**Why eval_type='custom' again?**
Same rationale as `evaluate_with_llm_judge`. Citation verify spans safety + accuracy + completeness; shoehorning it into one category loses information. Custom bucket + rule_results provenance wins until LLM-era usage patterns stabilize.
