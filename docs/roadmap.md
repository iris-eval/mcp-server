# Iris Roadmap

Updated 2026-09-07.

**The capability map is the roadmap.** Every evaluation question × every subject Iris can be asked about, with what it has, has with a stated limit, and lacks: [`docs/capabilities.md`](capabilities.md) and https://iris-eval.com/capabilities. It is rendered from the truthbase at every release and drift-locked in CI, so it cannot describe the product as older or newer than it is. This file lists only what the map states as a gap and the work that is genuinely open; the per-version detail of what shipped lives in the [CHANGELOG](../CHANGELOG.md).

---

## Released

Every release since v0.1 is in the [CHANGELOG](../CHANGELOG.md) with its own verification recipe. The short version: v0.1–v0.4 built the server, the dashboard, the rule library and the nine-tool surface; v0.5.0 the context-grounded hallucination rule and HTTP ingest; v0.6.0 the correctness release; v0.7.0 the proof release (every built-in rule measured, the numbers on https://iris-eval.com/proof); v0.8.0 the first trajectory rules; v0.9.0 the verdict that explains itself; v0.10.0 the composer; v0.11.0 the act layer; v0.12.0 comparison across runs.

---

## Open, by track

Iris is an evaluation tool, so the thing it owes you above all else is evidence that its own evaluations are correct. Track 1 is first among equals. Nothing below is written in the present tense.

### Track 1 — Proof: measure our own evaluators

- Human agreement on the blind sample. The instrument (`proof/blind-sample.mjs`) shipped in v0.8.0; the label is pending.
- The LLM judge's and the citation verifier's own accuracy, stability and prompt/model sensitivity. The harness is complete (`npm run proof:judge`) and runs on a key you supply; the proof page says "pending" until a keyed run is committed.
- Chance-corrected agreement (Cohen's kappa / Krippendorff's alpha).

Shipped and therefore not listed here: per-rule precision, recall and F1 with 95% intervals; a labelled corpus for the ship verdict itself with a frozen held-out split; calibration; the threshold sweep; adversarial transforms; precision at four field prevalences. All on https://iris-eval.com/proof.

### Track 2 — Coverage: evaluate what actually fails

- Verification auditing — did the agent check its own work.
- Trace ingestion via OpenTelemetry GenAI semantic conventions.
- The task-completed question on a trajectory (whether the parts of an ask were *acted on*, not only answered); the capability map's Q5 row is its weakest.

Shipped and therefore not listed here: argument validity against the agent's own tool catalogue, grounding the output's citations in what the tools returned, multi-part ask coverage, injection compliance across a trajectory, step ceilings and `action_policy` (v0.11.0); silent tool failure and loops (v0.8.0); the context-grounded hallucination rule (v0.5.0).

### Track 3 — Reach: make Iris usable from wherever your agents run

- A CLI for quality gates and batch evaluation.
- Host hooks and SDKs for guaranteed capture. Under MCP a tool call is always the model's decision, so anything that *must* be recorded needs a path that does not depend on the model choosing to call it; today that path is `POST /api/v1/traces` ([docs/http-ingest.md](http-ingest.md)). The TypeScript LangChain wrapper in `packages/langchain/` is **unpublished**; LangChain agents should use HTTP ingest.
- Named datasets, so a comparison can be restricted to the cases you chose.
- A batch ingest shape and a dedicated `POST /evaluations` route.

Shipped and therefore not listed here: HTTP ingest with optional evaluation on write (v0.5.0); the Claude Code skill and plugin; server instructions, output schemas, structured errors, `iris://capabilities` (v0.9.0); runs, case keys, `compare_runs`, `compare_traces` and `evaluate_runs` (v0.12.0).

### Hosted and team features

**Status: under consideration, not under construction.** Shared team history, managed storage, alerting, retention policies, SSO/RBAC and audit export are all plausible additions, and the codebase is deliberately built so they can be added without disturbing the self-hosted path — tenant scoping already runs through every storage call, and the storage layer sits behind an adapter interface. None of it is being built today, and no pricing exists. Two commitments hold regardless: **nothing that is free today will move behind a paywall**, and **no compliance certification will be claimed before it is held**.

---

## Community

Framework integration guides, a contributor path for a rule with its proof (`docs/contributing-a-rule.md` is not yet written), example agents with Iris eval baked in, and a plugin contract for custom rules and storage adapters — all open.

## How to influence the roadmap

- Open an issue on [GitHub](https://github.com/iris-eval/mcp-server/issues) with a feature request
- Upvote existing feature requests with a thumbs-up reaction
- Join the discussion in pull requests and issues
- Contribute directly — see [CONTRIBUTING.md](../CONTRIBUTING.md)
