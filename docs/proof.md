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

Two kinds of rule, two kinds of number. Where a rule's documented definition
is a formula (an output length, a coverage count, a keyword overlap, a cost,
a token ratio), the corpus checks that the implementation matches its
definition, so precision and recall near 1.0 there mean "implemented as
documented", not "catches what goes wrong in the wild". Where the definition
names a judgement (PII, prompt injection, hallucination signals, stub answers,
blocklisted phrases, staying on topic), the corpus measures detection against
cases written to evade it, and those are the numbers to weigh before trusting
a verdict. The provenance line cites the release version the numbers were
generated for, not a commit: branch commits are squashed on merge, so a commit
hash on a public surface would be one a reader cannot resolve.

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
| `credible95` | The same three rates with a Dirichlet credible interval (`method.credible`): the confusion counts get a half-count prior each and the rates are read off 2,000 seeded draws. Where a family has zero errors the bootstrap's F1 interval is `[1, 1]` — every resample of zero errors has zero errors — and the credible interval still reaches below 1, which is the honest reading of thirteen positives. |
| `ppvAt` | What a fire is worth at four prevalences (1%, 5%, 20%, 50%): the share of fires that are real violations when violations are that common, from this rule's sensitivity and specificity. The corpus is roughly half positive; a deployment where one output in a hundred leaks reads the 1% column. |

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

## Transforms — the evasions a leak arrives in

The three critical rules match text. A leak that arrives with a zero-width
space inside the card number, a Cyrillic `о` in `password`, fullwidth digits,
a no-break space, a tab or a line break inside the evidence, or the case
swapped is the same leak. `results.json → transforms` and the transforms
table in `RESULTS.md` say how often each rule still catches it: for every
positive the rule caught untransformed with a span into the raw output, the
text inside every reported span is transformed and the rule re-run. Recall
per transform is the share still caught, with a Wilson interval, and the ids
it dropped are listed. A case the rule missed in the clear says nothing about
evasion and is not counted; a transform that does not apply to a span (no
letters to swap, no space to replace) is not counted for that case. The
table is a measurement of the rules as shipped; a normalisation pass that
changes it will change the numbers here, and nothing about the table
predicts which way.

## Recall by entity — what `no_pii` finds and what it does not

Every positive in the `pii` family names what it contains — `entities`, from
a fixed vocabulary (`proof/lib/corpus.ts → PII_ENTITIES`) written by the case
author and never by the detector. `results.json → entities` reads them back
per entity: `present` (cases containing it), `caught` (the rule failed the
case for any reason), `named` (the rule's evidence named this entity), and
recall as `named / present`. The vocabulary includes things the rule's
definition does not name — a street address, a password, a token carried in
a URL — so a gap in the definition shows as a row with `named` 0 instead of
as silence, and a case caught for another reason is visible as the gap
between `caught` and `named`.

## Custom rule types — conformance

A custom rule is the author's own constraint, so its accuracy is whether the
type does what its documented definition says under a declared config.
`proof/corpus/custom/<type>.json` holds one family per type (`regex_match`,
`regex_no_match`, `min_length`, `max_length`, `contains_keywords`,
`excludes_keywords`, `json_schema`, `cost_threshold`), each stating the
config it is measured under and a definition the cases are labelled by;
`npm run proof` builds the rule with the same factory `custom_rules` and
deployed rules go through and runs every case. A disagreement here is a rule
defect or a definition error — never an opinion — which is why these numbers
are reported under `custom` and not beside the detectors. The families are
generated by `proof/tools/compose-custom-v1.ts` and never hand-edited.

## The verdict, measured — the composite corpus

The per-rule numbers above say how often each rule is right about its own
question. A gate does not key on a rule; it keys on `passed`, the verdict the
composer makes from every rule that ran. That verdict has its own measurement.

`proof/composite/cases.json` holds a second corpus: the 24 real transcripts
(`tests/fixtures/real-transcripts/`) promoted as they are, and composed cases
built by splicing a case from a rule family into a clean transcript's output,
its input or one of its tool outputs — so which failure classes are present is
true by construction, never derived from a composer. Each case carries
`expected.shouldShip`: `false` when a must-not-ship class is present, `true`
for the clean bases and the lookalikes (a placeholder that is not a credential,
a quoted discussion of an injection, a legitimately empty search), overridable
by a human label. Cases are split `dev` / `test` by a hash of the id — the split
is never stored, so it cannot drift.

`npm run proof -- --composite` runs every case through the real engine at the
shipped defaults and scores three composers on the same rule results: the
**legacy** arithmetic that decided `passed` before 0.10.0, and the **risk**
composer that has decided it since — a class-grouped noisy-OR over the
published positive predictive values, gates and vetoes first, then the risk
against a loss-derived threshold — under two readings of its prior. The risk
composer is the one in the package (`src/eval/risk.ts`), and the harness
imports the module that ships rather than a copy of it, so this table measures
the code you run. `eval.composer: "legacy"` selects the old arithmetic for two
minor releases, which is why it is still scored here.

It writes `proof/composite-results.json` and `proof/COMPOSITE.md`; CI runs
`npm run proof -- --check --composite` and fails on any difference, so the
committed numbers are the code's. Read there:

| Block | What it says |
|---|---|
| accuracy vs `shouldShip` | per split and composer, with a Wilson interval; the test split is the headline, the real transcripts are the out-of-sample line |
| false blocks on clean · missed blocks | the two ways a verdict is wrong, separately, because a gate cares about them differently |
| difference from legacy | accuracy(risk) − accuracy(legacy) with a Newcombe hybrid-score interval; an interval that straddles zero says the corpus cannot tell them apart |
| calibration | Brier score and expected calibration error over ten bins, for the legacy score read as P(bad) = 1 − score and for the risk's p_bad |
| recall by failure class | class present → some rule mapped to it fired; a class with no shipped detector reads 0 and says so |
| threshold sweep | on the dev split only; the utility-optimal τ is published as a check on the loss model, never adopted |

**What the two prior readings are.** The risk composer needs a prior that an
output is bad. Read *per class* — each of the ten examined failure classes
present with probability one half — the prior that nothing is wrong is one in a
thousand, and the composer blocks nearly every output; the table shows it. Read
*per output* — one half that the output is bad at all, spread over the examined
classes — a single fire of a detector for a rare class does not on its own
cross the threshold; the table shows that too. Which reading ships, and at
what default, is a decision the numbers inform; the file states both so it is
not made by preference.

The composed cases are built from the same synthetic, same-model-labelled
families as the per-rule numbers, so the accuracy here is conditional on that
corpus. The real-transcript line is the only out-of-sample one.

## The 24 real transcripts

`npm run proof -- --transcripts` writes `proof/transcript-results.json` and
`proof/TRANSCRIPTS.md`, and `--check --transcripts` diffs both against what
the code produces. These are agent runs against this repository, captured
before any of the rules that judge them existed, with an answer key written
at capture time — the only measurement here that is not conditional on a
corpus authored alongside the rule it measures.

It reports three numbers, and they are **not the same number**:

| Number | What it says |
|---|---|
| **failure classes present that some rule caught** | of the classes a person said were in these traces, how many a rule declaring that class actually failed on. The headline, because it needs no relabelling as rules are added |
| **ship verdicts agreeing** | whether the verdict a gate keys on matched "no failure class is present" |
| **bundle verdicts agreeing** | the legacy per-bundle arithmetic, and the weakest of the three: a bundle is a weighted mean, so one failing non-critical rule in a bundle of six does not move it |

**The gap set is measured, not typed.** A bundle verdict that disagrees with
the answer key is a *gap*, and until arc 4 the gaps lived in a hand-written
table in `tests/real-transcripts.test.ts`. A table like that can only rot in
one direction: a gap that CLOSES stays recorded as open, because nothing
re-derives it and closing it is invisible. The runner now measures the gaps,
the test reads what it wrote, and a drift-lock asserts the two agree exactly
— so a stale reason and an unexplained new gap both go red.

**Two limits, stated rather than discovered.** The transcripts cap tool
output at 600 characters, which is a fixture artefact: `grounded_in_reads`
declines an incomplete read set on purpose, so this set is a weak instrument
for that rule. And they use exactly two tools, both always well formed, so
`valid_tool_arguments` finds nothing here and contributes nothing to the
number — its measurement comes entirely from its own family and the composed
cases.

## Skips, and why a family may not have many

This runner scores a **skipped** case as *not failed*. So a skip on a
NEGATIVE case is a free true negative: it inflates specificity, which
inflates the published positive predictive value — which, since 0.10.0, is
arithmetic inside the verdict. A family carrying skips has been quietly
overstating its precision.

The fix is discipline rather than arithmetic, and the runner enforces it: a
family may skip at most **20%** of its cases, and one that skips at all must
say why in its own header, so a reader meets the caveat beside the number.
Skip-path behaviour is proved in unit tests, never in a family.

## The evaluator of evaluators

`docs/evaluators.md` asks the thirteen trust questions — does it work, when
does it fail, what does it measure, is it calibrated, can it be gamed, can it
produce false confidence, and seven more — of every evaluator Iris ships, and
answers each cell from the proof files: a cell reads *measured* only when a
number for it exists in `results.json`, `composite-results.json` or
`judge-results.json`, and names the file and key. It is rendered from
`.claims.json → evaluators` by `npm run llms:render`; the generator is
`scripts/claims/generators/evaluators.mjs` and `tests/evaluators-matrix.test.ts`
locks the count every surface quotes to what the files hold.

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
