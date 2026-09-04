# Proof — every built-in rule measured on a labelled corpus

This directory holds the labelled corpus, the runner and the results that stand
behind any sentence in this repository of the form "measured against a labeled
corpus". A number that is not in `proof/results.json` is not a measurement.

```bash
npm run proof              # evaluates every case, writes proof/results.json + proof/RESULTS.md
npm run proof -- --check   # regenerates to a temp path and exits 1 on any difference (CI)
```

Deterministic rules only: no network, no LLM calls, no API key. The runner
imports the rule registry (`src/eval/rules/index.ts`) and calls each rule's own
`evaluate` on each case, exactly as the engine does. The LLM judge and the
citation verifier are measured separately, with a cost cap, in
[`proof/judge/`](judge/README.md).

## Layout

| Path | What |
|---|---|
| `corpus/<rule>.json` | One family per built-in rule. Header states the rule, its documented definition and how the cases were labelled; `cases[]` carry `{ id, rule, label, input?, output, expected?, context?, notes, slots? }`. |
| `tools/convert-v0.mjs` | Converter that produced the four v0 families (`pii`, `injection`, `hallucination`, `stub`) from the source corpus. Those files are generated — never hand-edit them. |
| `lib/materialise.ts` | Regenerates credential-shaped values from placeholders at run time (below). |
| `lib/corpus.ts` | Schema, loader and validator for the case files. |
| `run.ts` | The runner. |
| `results.json` | Machine-readable results: per rule, the confusion matrix, precision / recall / F1 and 95% intervals. |
| `RESULTS.md` | The same numbers as a table. Generated; do not edit. |

`label` is `positive` when the rule **should fail** the output (the positive
class is the violation), `negative` when it should pass. So precision = of the
outputs the rule failed, the share that were real violations; recall = of the
real violations, the share the rule failed.

## Provenance of the four v0 families (`pii`, `injection`, `hallucination`, `stub`)

The following disclosures are copied verbatim from the source corpus's
`PROVENANCE.md` (iris proof corpus v0.1, post-review hygiene edition,
2026-08-11). Read them before citing any number.

> **All 359 cases are synthetic.** Every case was authored by LLM agents (Claude, operating inside the Lattice substrate). No case is sampled from production agent traffic. Scenarios, names, addresses, credentials, and documents are all fabricated.
>
> **The corpus is rule-aware by construction.** Cases were written with iris's shipped pattern/marker lists in hand: positives are deliberately written to evade the shipped regexes, and negatives are deliberately seeded with literal rule triggers (documentation placeholders, texts *about* injection, benign marker mentions). This is an adversarial stress corpus. Its numbers are corpus-conditional diagnostics of evadability — **not** estimates of detection rates on real traffic — and any rule change tuned against it risks overfitting a known target.
>
> The author knew each case's intended label at generation time.
>
> **Annotator A, annotator B, and the adjudicator were independent *contexts* of the same underlying model (Claude)** — separate annotation passes, but the same model family and the same substrate that authored the cases. They were not independent humans.
>
> The entire pipeline — case generation, 720 annotations, four adjudications, gold assembly, and the metrics run — was completed in a single working session on 2026-08-11.
>
> Labels were fixed by dual-annotation agreement, with disagreements resolved by adjudication. One case (stub-062) was dropped as undecidable; its annotation also demonstrated that the pipeline can carry draft-contamination artifacts (a rationale quoting a different draft of the case), which was caught only because it surfaced as a disagreement.
>
> The reported agreement (raw 98.89–100%, Cohen's kappa 0.978–1.0) measures **internal consistency of one model family re-reading its own authored cases**. It is NOT human-gold-standard agreement:
>
> - Same-model annotator passes have correlated errors; near-ceiling agreement is partially self-confirmation, because the cases were written to be clear positives/negatives.
> - With balanced marginals (~50/50), chance agreement is ~0.5, so kappa here is essentially rescaled raw agreement.
> - Treat the gold labels as "consistent with the stated failure definitions under adversarial spot-checking" (an independent 40-case spot-check in `methodology-review.md` found zero label errors), not as independently validated ground truth.
>
> **TODO: founder** — human blind-labeling of a stratified ~40-case sample (10 per family, weighted toward boundary/adjudicated cases), reporting human-vs-gold agreement alongside the model-internal kappa. This is the cheapest upgrade that converts the labels from internal-consistency evidence into human-validated evidence. Until it is done, no publication should describe the labels as "gold" without pointing here.

Two further points from the same source that govern how the numbers may be read:

- **The injection family measures payload presence in the supplied text, not
  output-side compliance.** Most of its positives are retrieved documents,
  emails and tool results passed through `output`. `no_injection_patterns`
  scopes itself to the agent's output and never reads the input; the family is
  kept because the `evaluate_output` description once sold unscoped "prompt
  injection" coverage, and the number says what the rule does on that
  population. It is not a firewall benchmark.
- **The rules were repaired with this corpus's failure classes in hand**
  (2026-08-12). A number here says "the evasions this corpus demonstrates are
  closed", not "this rule is accurate on your traffic".

Every case's rationale from the source is kept in `notes`, prefixed
`[adjudicated]` where the two annotators disagreed and an adjudicator ruled.

### Credentials are placeholders, materialised at run time

The source corpus carried realistic-looking fabricated secrets (an AWS key
pair, Slack / GitHub / SendGrid / Google / npm / DigitalOcean / Stripe / OpenAI
/ Twilio / Mailgun / Discord / Meta tokens, an Azure storage key, two JWTs,
two PEM private-key blocks, a wallet seed phrase) because the PII family exists
to measure whether the rules catch realistic leaks. None was ever a live
credential, but a string that looks like one does not belong in a public
repository.

The converter replaces each with a `{{SLOT}}` placeholder and stores the
value's **shape** beside the case — the literal vendor prefix plus a
character-class mask (`A` uppercase, `a` lowercase, `9` digit, `H`/`h` hex
letter, punctuation literal). `lib/materialise.ts` fills the mask from a
generator seeded with the case id, so every machine renders the same value and
every rule regex sees the same character class at every position. The
converter's `--verify` mode re-evaluates every case on the original text and on
the materialised text and refuses to write if any verdict moves.

## The nine other families

The remaining built-in rules (`min_output_length`, `non_empty_output`,
`sentence_count`, `expected_coverage`, `keyword_overlap`, `topic_consistency`,
`no_blocklist_words`, `cost_under_threshold`, `token_efficiency`) had no
labelled cases before this directory existed. Their families are described in
each file's header and in the section below once authored.

## How to read the intervals

Precision and recall are binomial proportions, so each carries a Wilson score
95% interval (`method.ci`). F1 is not a proportion; its interval is a seeded
percentile bootstrap over the family's cases (`method.f1Ci` names the exact
procedure and seed). With a few dozen cases per family the intervals are wide —
that width is the honest part of the number. Two rules whose intervals overlap
have not been shown to differ.

## Human agreement

`results.json → humanAgreement.status` is `pending` until the founder's blind
label of a 40-case stratified sample exists. When it does, the runner reports
human-vs-corpus agreement beside the model-internal figure above.

## Adding cases

1. Put the case in the right family file with a unique id, the documented
   label, and a `notes` line saying why the label is what it is.
2. Never paste a real credential, address, or person. Use the placeholder
   slots if a credential shape is the point of the case.
3. Run `npm run proof` and commit the regenerated `results.json` and
   `RESULTS.md` with the case — CI compares them byte-for-byte.
