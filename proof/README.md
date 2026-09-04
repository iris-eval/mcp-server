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

## The nine other families (authored 2026-09-04)

The remaining built-in rules (`min_output_length`, `non_empty_output`,
`sentence_count`, `expected_coverage`, `keyword_overlap`, `topic_consistency`,
`no_blocklist_words`, `cost_under_threshold`, `token_efficiency`) had no
labelled cases before this directory existed. Their families
(`corpus/<rule>.json`) were **LLM-authored and LLM-labelled against each
rule's documented definition on 2026-09-04** — the definition in
`docs/api-reference.md` and the rule's own description, quoted in each file's
`definition` header — not by running the rule. The labeller is the same model
family that wrote the cases; no human has checked these labels. Specifically:

- Where the documented definition is a formula (character count, term
  coverage, keyword overlap, cost, token ratio), the label is that formula
  applied by an independent script, and every case's `notes` states the
  count that decided it.
- Where the definition is a reader's judgement (sentence count, presence of a
  blocklisted phrase, "stays on topic"), the label is what a reader would
  say, and the notes disclose where the documented *mechanism* is expected to
  disagree (a decimal point read as a sentence end; a zero-width space inside
  a banned phrase; an on-topic answer that avoids the question's words). Those
  cases are boundaries on purpose: the misses they produce are the rule's
  documented limits, made visible.
- The two relevance rules were redesigned the same day (#416, `9d9fd50`),
  and their documented definitions changed with them: `keyword_overlap`
  became recall of the input's *content terms* at 35% (stopwords and request
  verbs excluded, identifiers split, inflections folded) instead of 20% of
  all words, and `topic_consistency` became *continuity* — the share of the
  output's content sentences that connect to the input, at one third —
  instead of the share of output words found in the input. Both families
  were re-labelled on 2026-09-04 against the new documented definitions by
  an independent reading of them (its own stopword list, sentence splitting
  and inflection folding, not the rule's), and each file's header names the
  definition version it is labelled against. Cases undecidable from the
  documentation alone were dropped rather than guessed: five real-transcript
  cases in the keyword family (within seven points of the threshold) and,
  in the topic family, four authored cases whose point was that a shared
  word is not topical relevance — a distinction the new definition
  explicitly does not make. The topic header spells out the two
  consequences a reader should know: an off-target answer that reuses the
  question's vocabulary connects, and an on-topic answer in fresh words does
  not.

Every family holds at least six cases derived from **real agent transcripts**:
the input/output pairs (and, for the cost family, the token and dollar
figures) of an agent that genuinely performed 24 tasks against this repository
on 2026-09-03, including its real failures (a fabricated file name, an answer
to only one of three parts, a promise instead of work, ten document reads for
one fact). They are marked `real transcript t-NN` in `notes`. The transcripts
themselves are not published; the pairs are reproduced verbatim in the cases.

## How to read the intervals

Precision and recall are binomial proportions, so each carries a Wilson score
95% interval (`method.ci`). F1 is not a proportion; its interval is a seeded
percentile bootstrap over the family's cases (`method.f1Ci` names the exact
procedure and seed). With a few dozen cases per family the intervals are wide —
that width is the honest part of the number. Two rules whose intervals overlap
have not been shown to differ.

## Human agreement

The corpus is LLM-authored and LLM-labelled, which is the biggest caveat on
every number above: a model can agree with itself and still be wrong about what
a rule means. Human agreement on a sample is what tells those two apart.

`node proof/blind-sample.mjs` draws a reproducible 40-case stratified sample
into `proof/blind-sample.json` — case ids in a fixed shuffled order, no labels,
so the manifest is safe to hand to an annotator. `--check` proves the committed
manifest is what the seed produces; `--score <answers.json>` scores a returned
answer sheet against the corpus and prints every disagreement with the corpus's
own reasoning beside it.

The sample covers the **seven judgment families only** (`no_pii`,
`no_injection_patterns`, `no_hallucination_markers`, `no_stub_output`,
`no_blocklist_words`, `no_silent_tool_failure`, `no_tool_loop`). The other eight
rules are arithmetic — a character count, a token ratio, a cost against a
threshold, a share of overlapping terms — and asking a person to eyeball
"is at least 35% of this input's vocabulary present in the output" is asking
them to do long division. A disagreement there would mean the annotator
miscounted, which says nothing about whether the rule is right; those
definitions are verified by the test suite instead.

Every disagreement is worth something either way. It means the case is
mislabelled, or the rule is defined loosely enough that two careful readers land
in different places. Both are defects, and both get fixed in the open.

### Two reviewers, two questions

A reviewer who has read the code and one who has not are useful for different
things, and asking them the same question wastes one of them.

| | The question | Scored with |
|---|---|---|
| **Reviewed the code** | Is this case labelled correctly against the rule's written definition? | `node proof/blind-sample.mjs --score <sheet>` |
| **Has not** | Would you want to be told about this output, or is it fine? | `npm run proof:review <sheet>` |

The second question is the one that can tell us the rules are wrong. Its scorer
runs every answered case through the real registry and classifies the
disagreements as the **product's**, never the reviewer's:

- **A miss** is an output the reviewer wanted flagged that Iris passed. It is the
  expensive kind, because nothing in production reports an alarm that never rang.
- **A false alarm** is an output Iris flagged that the reviewer would have waved
  through. Each one is a person dismissing a warning, and enough of them teach
  people to dismiss all of them.

There is no answer key in that mode. A reviewer cannot be wrong, only surprised,
and every surprise is ours to fix.

**In the definition-conformance mode, the verdict and the opinion are different
answers, and the sheet keeps them apart.** The verdict is about the rule *as written*: read the definition,
including any threshold it names, and say whether this output matches it. That
is what the corpus labels mean, so it is what agreement is computed against. The
separate `ruleWrong` flag is the annotator saying the definition itself should
be different. A flagged case is not a disagreement, and `--score` reports the
flags on their own line even when agreement is perfect, because "the rule is
written wrong" is a product decision and "the label is wrong" is a data defect.
Collapsing them loses the more valuable of the two.

`results.json → humanAgreement.status` stays `pending` until a scored answer
sheet exists.

## Adding cases

1. Put the case in the right family file with a unique id, the documented
   label, and a `notes` line saying why the label is what it is.
2. Never paste a real credential, address, or person. Use the placeholder
   slots if a credential shape is the point of the case.
3. Run `npm run proof` and commit the regenerated `results.json` and
   `RESULTS.md` with the case — CI compares them byte-for-byte.
