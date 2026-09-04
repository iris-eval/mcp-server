# Proof — how the evaluator accuracy numbers are made

Every built-in rule in Iris has a published precision, recall and F1 with 95%
confidence intervals, measured on a labelled corpus that lives in this
repository and regenerates with one command. The numbers are in
[`proof/results.json`](../proof/results.json) (machine-readable) and
[`proof/RESULTS.md`](../proof/RESULTS.md) (a table), and on
[iris-eval.com/proof](https://iris-eval.com/proof). This page explains how to
run the measurement, how to read it, what the corpus is and is not, and how to
add to it. It deliberately restates no number: the files above are the only
place a number lives.

## Run it

```bash
npm run proof              # measure every rule, write proof/results.json + proof/RESULTS.md
npm run proof -- --check   # regenerate to a temp dir; exit 1 on any difference (what CI runs)
npm run proof:typecheck    # type-check the runner and its libraries
```

No network, no API key, no LLM call. The runner imports the rule registry
(`src/eval/rules/index.ts`) and calls each rule's own `evaluate` on each case,
with the context the case declares — the same objects the evaluation engine
runs. A run takes a few seconds and produces identical bytes on every machine
apart from the generation time and commit hash, which the `--check` comparison
ignores.

The `proof` job in `.github/workflows/ci.yml` runs `--check` on every pull
request, so a change to a rule cannot merge without the committed numbers
changing with it. The truthbase (`.claims.json → proof`, written by
`scripts/claims/generators/proof.mjs`) copies `proof/results.json` verbatim;
the website, `llms.txt` and the README read from there and never restate a
value.

The LLM judge and the citation verifier are measured separately, with real
provider calls under a cost cap — see [`proof/judge/README.md`](../proof/judge/README.md)
and [llm-as-judge.md](llm-as-judge.md). Their results land in
`proof/judge-results.json` and are copied into `.claims.json → proof.judge`.

## Read it

For each rule the results carry the confusion matrix and three rates:

| Field | Meaning |
|---|---|
| `positives` / `negatives` | Cases labelled as a violation the rule **should fail** / cases it should pass. The positive class is always the violation. |
| `tp` `fp` `fn` `tn` | True positives (a violation the rule failed), false positives (a clean case it failed), false negatives (a violation it passed or skipped), true negatives. |
| `precision` | Of the outputs the rule failed, the share that were real violations. Low precision means the rule cries wolf. |
| `recall` | Of the real violations, the share the rule failed. Low recall means it misses. |
| `f1` | The harmonic mean of the two. |
| `skipped` | Cases where the rule declined to judge (missing context, output too brief). A skip is counted as "did not fail". |
| `ci95` | 95% intervals: Wilson score for precision and recall; a seeded percentile bootstrap for F1 (`method.f1Ci` names the exact procedure). |

**How to read an interval.** A family holds a few dozen cases, so an observed
rate is a noisy estimate of the rule's behaviour on cases like these. The
interval is the range of true rates consistent with what was observed; its
width is the honest part of the number. Two rules whose intervals overlap have
not been shown to differ, and a rate of 100% on thirty cases still carries an
interval that reaches well below it. Wilson intervals stay inside 0–1 and
behave at the edges, which the textbook normal approximation does not.

**What the misses mean.** `proof/RESULTS.md` lists the ids of every false
positive and false negative so you can open the case and judge the miss for
yourself. Many are deliberate boundary cases — a decimal point read as a
sentence end, a zero-width space inside a banned phrase, an on-topic answer
that avoids the question's words — placed to make a rule's documented limit
visible rather than to flatter it.

## What the corpus is, and is not

The corpus is in [`proof/corpus/`](../proof/corpus/), one file per rule, and
[`proof/README.md`](../proof/README.md) is its full provenance statement. The
short version:

- **Every case is synthetic and LLM-authored.** No case comes from production
  traffic. The four safety families (PII, injection, hallucination, stub) were
  written on 2026-08-11 with the rules' pattern lists in hand — positives
  written to evade them, negatives seeded with their triggers — and labelled by
  two independent contexts of the same model with adjudication. The other nine
  families were written and labelled on 2026-09-04 against each rule's
  **documented** definition, not by running the rule.
- **The labels are not human gold.** The same model family wrote the cases and
  labelled them. A founder blind label of a stratified 40-case sample is
  pending; until it exists, `humanAgreement.status` is `pending` and no page
  may call the labels "gold".
- **The numbers are corpus-conditional.** The safety rules were repaired with
  this corpus's failure classes in hand, so their numbers say "the evasions
  this corpus demonstrates are closed", not "this rule is accurate on your
  agents". Treat every rate as an upper bound on a known target.
- **Real transcripts are represented, thinly.** Each of the nine newer families
  holds at least six cases whose input and output come from an agent that
  really performed a task against this repository, including its real
  failures. They are marked `real transcript t-NN` in the case notes.
- **The injection family measures payload presence in the supplied text.**
  Most of its positives are retrieved documents passed through `output`; the
  rule scopes itself to the agent's output. The number says what the rule does
  on that population, not whether Iris is an input firewall (it is not).
- **Credentials are placeholders.** Credential-shaped strings are stored as
  `{{SLOT}}` placeholders with a character-class mask and regenerated
  deterministically at run time, so the repository never holds a string a
  secret scanner could mistake for a live key while every rule regex sees the
  same shape. The converter proved on the source corpus that no verdict moved.

## Add cases

1. Open the family file for the rule (`proof/corpus/<rule>.json`). Read its
   `definition` header — the documented definition the labels are judged
   against — and label your case against that, not against what the rule
   happens to return today.
2. Add the case with a unique id, `label: "positive"` when the rule **should
   fail** the output and `"negative"` when it should pass, the text fields the
   rule reads (`input`, `output`, `expected`) and, for the cost rules, a
   `context` object with `costUsd` or `tokenUsage`. Say why in `notes`.
3. Never paste a real person, address or credential. If a credential shape is
   the point, add a `slots` entry with a mask and use `{{SLOT}}` in the text.
4. Run `npm run proof` and commit the regenerated `proof/results.json` and
   `proof/RESULTS.md` together with the case, then `npm run claims:generate`
   and `npm run llms:render` so the truthbase and the LLM-facing surface carry
   the new numbers. CI checks all three.

The four v0 families are generated by `proof/tools/convert-v0.mjs` from their
source corpus and must not be hand-edited; a new case for those rules goes into
the source and is reconverted.
