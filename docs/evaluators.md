# Evaluator of evaluators — the thirteen trust questions, asked of every evaluator Iris ships

Rendered from `.claims.json → evaluators` by `npm run llms:render`; do not edit `docs/evaluators.md` by hand. Evaluators with three or more of the thirteen trust questions measured: 26 of 32 (the built-in rules 17 of 17; the custom rule types 8 of 8; the LLM-judge templates 0 of 5; the citation verifier 0 of 1; the verdict composer 1 of 1) — every number behind a measured cell is on https://iris-eval.com/proof and in the proof files it names.

Every cell is derived from the committed proof files by `scripts/claims/generators/evaluators.mjs` — never typed. A cell reads **measured** only when a number for it exists in `proof/results.json`, `proof/composite-results.json` or `proof/judge-results.json`, and the evidence list below names the file and key. The other statuses: **partial** (part of the question has a number — the misses are named by id, but no rate), **stated** (the answer is a declaration in code or a corpus definition, not a measurement), **measurable** (the harness that would measure it is named; no number yet), **n/a** (the question does not apply — a deterministic rule has no prompt or model sensitivity). The judge templates and the citation verifier stay measurable until a judge key that the founder or a user supplies runs `npm run proof:judge`; every other row moves only when a release roll regenerates the proof files.

Marks: ● measured · ◐ partial · ≡ stated · ○ measurable · — n/a.

| # | Question |
|--:|---|
| 1 | How do we know this evaluator works? |
| 2 | Under what conditions does it fail? |
| 3 | What does the metric actually measure? |
| 4 | What does it only appear to measure? |
| 5 | Is the output calibrated? |
| 6 | How sensitive is it to prompt variation? |
| 7 | How sensitive is it to model choice? |
| 8 | How stable is it across repeated runs? |
| 9 | Can it be gamed? |
| 10 | Can it produce false confidence? |
| 11 | Does it correlate with the outcome we care about? |
| 12 | Can deterministic evidence corroborate model-based judgment? |
| 13 | Can multiple independent methods triangulate the same conclusion? |

## The built-in rules — 17 of 17 with three or more questions measured

| Evaluator | Q1 | Q2 | Q3 | Q4 | Q5 | Q6 | Q7 | Q8 | Q9 | Q10 | Q11 | Q12 | Q13 | measured |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|--:|
| `min_output_length` | ● | ◐ | ≡ | ≡ | ○ | — | — | ● | ○ | ● | ● | ○ | ○ | 4 |
| `non_empty_output` | ● | ◐ | ≡ | ≡ | ○ | — | — | ● | ○ | ● | ● | ○ | ○ | 4 |
| `sentence_count` | ● | ◐ | ≡ | ≡ | ○ | — | — | ● | ○ | ● | ● | ○ | ○ | 4 |
| `expected_coverage` | ● | ◐ | ≡ | ≡ | ○ | — | — | ● | ○ | ● | ● | ○ | ○ | 4 |
| `valid_tool_arguments` | ● | ◐ | ≡ | ≡ | ○ | — | — | ● | ○ | ● | ● | ○ | ○ | 4 |
| `keyword_overlap` | ● | ◐ | ≡ | ≡ | ○ | — | — | ● | ○ | ● | ● | ○ | ○ | 4 |
| `topic_consistency` | ● | ◐ | ≡ | ≡ | ○ | — | — | ● | ○ | ● | ● | ○ | ○ | 4 |
| `no_pii` | ● | ● | ≡ | ≡ | ○ | — | — | ● | ● | ● | ● | ○ | ○ | 6 |
| `no_blocklist_words` | ● | ● | ≡ | ≡ | ○ | — | — | ● | ● | ● | ○ | ○ | ○ | 5 |
| `no_injection_patterns` | ● | ● | ≡ | ≡ | ○ | — | — | ● | ● | ● | ● | ○ | ○ | 6 |
| `no_stub_output` | ● | ◐ | ≡ | ≡ | ○ | — | — | ● | ○ | ● | ● | ○ | ○ | 4 |
| `no_hallucination_markers` | ● | ◐ | ≡ | ≡ | ○ | — | — | ● | ○ | ● | ● | ○ | ○ | 4 |
| `no_silent_tool_failure` | ● | ◐ | ≡ | ≡ | ○ | — | — | ● | ○ | ● | ● | ○ | ○ | 4 |
| `grounded_in_reads` | ● | ◐ | ≡ | ≡ | ○ | — | — | ● | ○ | ● | ● | ○ | ○ | 4 |
| `cost_under_threshold` | ● | ◐ | ≡ | ≡ | ○ | — | — | ● | ○ | ● | ● | ○ | ○ | 4 |
| `verbosity_ratio` | ● | ◐ | ≡ | ≡ | ○ | — | — | ● | ○ | ● | ● | ○ | ○ | 4 |
| `no_tool_loop` | ● | ◐ | ≡ | ≡ | ○ | — | — | ● | ○ | ● | ● | ○ | ○ | 4 |

## The custom rule types — 8 of 8 with three or more questions measured

| Evaluator | Q1 | Q2 | Q3 | Q4 | Q5 | Q6 | Q7 | Q8 | Q9 | Q10 | Q11 | Q12 | Q13 | measured |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|--:|
| `regex_match` | ● | ≡ | ≡ | ≡ | — | — | — | ● | ○ | ● | — | — | ○ | 3 |
| `regex_no_match` | ● | ≡ | ≡ | ≡ | — | — | — | ● | ○ | ● | — | — | ○ | 3 |
| `min_length` | ● | ≡ | ≡ | ≡ | — | — | — | ● | — | ● | — | — | ○ | 3 |
| `max_length` | ● | ≡ | ≡ | ≡ | — | — | — | ● | — | ● | — | — | ○ | 3 |
| `contains_keywords` | ● | ≡ | ≡ | ≡ | — | — | — | ● | ○ | ● | — | — | ○ | 3 |
| `excludes_keywords` | ● | ≡ | ≡ | ≡ | — | — | — | ● | ○ | ● | — | — | ○ | 3 |
| `json_schema` | ● | ≡ | ≡ | ≡ | — | — | — | ● | — | ● | — | — | ○ | 3 |
| `cost_threshold` | ● | ≡ | ≡ | ≡ | — | — | — | ● | — | ● | — | — | ○ | 3 |

## The LLM-judge templates — 0 of 5 with three or more questions measured

| Evaluator | Q1 | Q2 | Q3 | Q4 | Q5 | Q6 | Q7 | Q8 | Q9 | Q10 | Q11 | Q12 | Q13 | measured |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|--:|
| `accuracy` | ○ | ○ | ≡ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | 0 |
| `helpfulness` | ○ | ○ | ≡ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | 0 |
| `safety` | ○ | ○ | ≡ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | 0 |
| `correctness` | ○ | ○ | ≡ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | 0 |
| `faithfulness` | ○ | ○ | ≡ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | 0 |

## The citation verifier — 0 of 1 with three or more questions measured

| Evaluator | Q1 | Q2 | Q3 | Q4 | Q5 | Q6 | Q7 | Q8 | Q9 | Q10 | Q11 | Q12 | Q13 | measured |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|--:|
| `verify_citations` | ○ | ○ | ≡ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | 0 |

## The verdict composer — 1 of 1 with three or more questions measured

| Evaluator | Q1 | Q2 | Q3 | Q4 | Q5 | Q6 | Q7 | Q8 | Q9 | Q10 | Q11 | Q12 | Q13 | measured |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|--:|
| `the verdict composer (passed)` | ● | ● | ≡ | ● | ● | — | — | ● | ○ | ● | ● | ○ | ○ | 7 |

## Evidence, per evaluator

Measured cells name the file and key; measurable cells name the harness; stated cells name where the declaration lives.

### `min_output_length` (the built-in rules)

- **Q1** measured — proof/results.json → rules[min_output_length] (precision, recall and F1 on 29 labelled cases with Wilson and credible 95% intervals; in-sample, same-model labelled until the blind label lands)
- **Q2** partial — proof/RESULTS.md → misses by case id (every false positive and false negative is named by id; no rate under transforms (the rule reports no span, or is not critical))
- **Q3** stated — list_rules → kind: measurement, mechanism: formula; proof/corpus → definition (a measurement or policy: the proof family measures conformance to the stated formula, not detection of a failure)
- **Q4** stated — every result since 0.9.0 carries kind and mechanism (the kind label says it is a formula, so it cannot appear to be a detector)
- **Q5** measurable — proof/lib/composite-report.ts calibration, per rule score (a per-rule reliability curve over the composite corpus is the harness; only the composer is calibrated today)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check regenerates the file byte for byte in CI on every pull request (a pure function of its input; the committed numbers are the code's)
- **Q9** measurable — proof/lib/transforms.ts extends to any rule that reports a span
- **Q10** measured — proof/results.json → rules[min_output_length].ppvAt (what a fire is worth at 1%, 5%, 20% and 50% prevalence, from the family's counts)
- **Q11** measured — proof/composite-results.json → perClass[format] (recall on composed cases and the 24 real transcripts where the class is present)
- **Q12** measurable — pair rule fires with the judge's dimensions on one corpus (needs a key)
- **Q13** measurable — run the rules over the judge corpus and the judge over the rule corpus; publish the agreement per pair (needs a key)

### `non_empty_output` (the built-in rules)

- **Q1** measured — proof/results.json → rules[non_empty_output] (precision, recall and F1 on 29 labelled cases with Wilson and credible 95% intervals; in-sample, same-model labelled until the blind label lands)
- **Q2** partial — proof/RESULTS.md → misses by case id (every false positive and false negative is named by id; no rate under transforms (the rule reports no span, or is not critical))
- **Q3** stated — list_rules → kind: policy, mechanism: formula; proof/corpus → definition (a measurement or policy: the proof family measures conformance to the stated formula, not detection of a failure)
- **Q4** stated — every result since 0.9.0 carries kind and mechanism (the kind label says it is a formula, so it cannot appear to be a detector)
- **Q5** measurable — proof/lib/composite-report.ts calibration, per rule score (a per-rule reliability curve over the composite corpus is the harness; only the composer is calibrated today)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check regenerates the file byte for byte in CI on every pull request (a pure function of its input; the committed numbers are the code's)
- **Q9** measurable — proof/lib/transforms.ts extends to any rule that reports a span
- **Q10** measured — proof/results.json → rules[non_empty_output].ppvAt (what a fire is worth at 1%, 5%, 20% and 50% prevalence, from the family's counts)
- **Q11** measured — proof/composite-results.json → perClass[format] (recall on composed cases and the 24 real transcripts where the class is present)
- **Q12** measurable — pair rule fires with the judge's dimensions on one corpus (needs a key)
- **Q13** measurable — run the rules over the judge corpus and the judge over the rule corpus; publish the agreement per pair (needs a key)

### `sentence_count` (the built-in rules)

- **Q1** measured — proof/results.json → rules[sentence_count] (precision, recall and F1 on 30 labelled cases with Wilson and credible 95% intervals; in-sample, same-model labelled until the blind label lands)
- **Q2** partial — proof/RESULTS.md → misses by case id (every false positive and false negative is named by id; no rate under transforms (the rule reports no span, or is not critical))
- **Q3** stated — list_rules → kind: measurement, mechanism: formula; proof/corpus → definition (a measurement or policy: the proof family measures conformance to the stated formula, not detection of a failure)
- **Q4** stated — every result since 0.9.0 carries kind and mechanism (the kind label says it is a formula, so it cannot appear to be a detector)
- **Q5** measurable — proof/lib/composite-report.ts calibration, per rule score (a per-rule reliability curve over the composite corpus is the harness; only the composer is calibrated today)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check regenerates the file byte for byte in CI on every pull request (a pure function of its input; the committed numbers are the code's)
- **Q9** measurable — proof/lib/transforms.ts extends to any rule that reports a span
- **Q10** measured — proof/results.json → rules[sentence_count].ppvAt (what a fire is worth at 1%, 5%, 20% and 50% prevalence, from the family's counts)
- **Q11** measured — proof/composite-results.json → perClass[format] (recall on composed cases and the 24 real transcripts where the class is present)
- **Q12** measurable — pair rule fires with the judge's dimensions on one corpus (needs a key)
- **Q13** measurable — run the rules over the judge corpus and the judge over the rule corpus; publish the agreement per pair (needs a key)

### `expected_coverage` (the built-in rules)

- **Q1** measured — proof/results.json → rules[expected_coverage] (precision, recall and F1 on 29 labelled cases with Wilson and credible 95% intervals; in-sample, same-model labelled until the blind label lands)
- **Q2** partial — proof/RESULTS.md → misses by case id (every false positive and false negative is named by id; no rate under transforms (the rule reports no span, or is not critical))
- **Q3** stated — list_rules → kind: measurement, mechanism: formula; proof/corpus → definition (a measurement or policy: the proof family measures conformance to the stated formula, not detection of a failure)
- **Q4** stated — every result since 0.9.0 carries kind and mechanism (the kind label says it is a formula, so it cannot appear to be a detector)
- **Q5** measurable — proof/lib/composite-report.ts calibration, per rule score (a per-rule reliability curve over the composite corpus is the harness; only the composer is calibrated today)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check regenerates the file byte for byte in CI on every pull request (a pure function of its input; the committed numbers are the code's)
- **Q9** measurable — proof/lib/transforms.ts extends to any rule that reports a span
- **Q10** measured — proof/results.json → rules[expected_coverage].ppvAt (what a fire is worth at 1%, 5%, 20% and 50% prevalence, from the family's counts)
- **Q11** measured — proof/composite-results.json → perClass[incomplete_ask] (recall on composed cases and the 24 real transcripts where the class is present)
- **Q12** measurable — pair rule fires with the judge's dimensions on one corpus (needs a key)
- **Q13** measurable — run the rules over the judge corpus and the judge over the rule corpus; publish the agreement per pair (needs a key)

### `valid_tool_arguments` (the built-in rules)

- **Q1** measured — proof/results.json → rules[valid_tool_arguments] (precision, recall and F1 on 33 labelled cases with Wilson and credible 95% intervals; in-sample, same-model labelled until the blind label lands)
- **Q2** partial — proof/RESULTS.md → misses by case id (every false positive and false negative is named by id; no rate under transforms (the rule reports no span, or is not critical))
- **Q3** stated — list_rules → kind: detection, mechanism: formula; proof/corpus → definition (a detection or inference: the family measures detection of the named failure classes)
- **Q4** stated — every result since 0.9.0 carries kind and mechanism (the kind label names the claim; what it appears to measure beyond that is not measured)
- **Q5** measurable — proof/lib/composite-report.ts calibration, per rule score (a per-rule reliability curve over the composite corpus is the harness; only the composer is calibrated today)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check regenerates the file byte for byte in CI on every pull request (a pure function of its input; the committed numbers are the code's)
- **Q9** measurable — proof/lib/transforms.ts extends to any rule that reports a span
- **Q10** measured — proof/results.json → rules[valid_tool_arguments].ppvAt (what a fire is worth at 1%, 5%, 20% and 50% prevalence, from the family's counts)
- **Q11** measured — proof/composite-results.json → perClass[invalid_tool_call] (recall on composed cases and the 24 real transcripts where the class is present)
- **Q12** measurable — pair rule fires with the judge's dimensions on one corpus (needs a key)
- **Q13** measurable — run the rules over the judge corpus and the judge over the rule corpus; publish the agreement per pair (needs a key)

### `keyword_overlap` (the built-in rules)

- **Q1** measured — proof/results.json → rules[keyword_overlap] (precision, recall and F1 on 30 labelled cases with Wilson and credible 95% intervals; in-sample, same-model labelled until the blind label lands)
- **Q2** partial — proof/RESULTS.md → misses by case id (every false positive and false negative is named by id; no rate under transforms (the rule reports no span, or is not critical))
- **Q3** stated — list_rules → kind: measurement, mechanism: formula; proof/corpus → definition (a measurement or policy: the proof family measures conformance to the stated formula, not detection of a failure)
- **Q4** stated — every result since 0.9.0 carries kind and mechanism (the kind label says it is a formula, so it cannot appear to be a detector)
- **Q5** measurable — proof/lib/composite-report.ts calibration, per rule score (a per-rule reliability curve over the composite corpus is the harness; only the composer is calibrated today)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check regenerates the file byte for byte in CI on every pull request (a pure function of its input; the committed numbers are the code's)
- **Q9** measurable — proof/lib/transforms.ts extends to any rule that reports a span
- **Q10** measured — proof/results.json → rules[keyword_overlap].ppvAt (what a fire is worth at 1%, 5%, 20% and 50% prevalence, from the family's counts)
- **Q11** measured — proof/composite-results.json → perClass[off_task] (recall on composed cases and the 24 real transcripts where the class is present)
- **Q12** measurable — pair rule fires with the judge's dimensions on one corpus (needs a key)
- **Q13** measurable — run the rules over the judge corpus and the judge over the rule corpus; publish the agreement per pair (needs a key)

### `topic_consistency` (the built-in rules)

- **Q1** measured — proof/results.json → rules[topic_consistency] (precision, recall and F1 on 31 labelled cases with Wilson and credible 95% intervals; in-sample, same-model labelled until the blind label lands)
- **Q2** partial — proof/RESULTS.md → misses by case id (every false positive and false negative is named by id; no rate under transforms (the rule reports no span, or is not critical))
- **Q3** stated — list_rules → kind: measurement, mechanism: formula; proof/corpus → definition (a measurement or policy: the proof family measures conformance to the stated formula, not detection of a failure)
- **Q4** stated — every result since 0.9.0 carries kind and mechanism (the kind label says it is a formula, so it cannot appear to be a detector)
- **Q5** measurable — proof/lib/composite-report.ts calibration, per rule score (a per-rule reliability curve over the composite corpus is the harness; only the composer is calibrated today)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check regenerates the file byte for byte in CI on every pull request (a pure function of its input; the committed numbers are the code's)
- **Q9** measurable — proof/lib/transforms.ts extends to any rule that reports a span
- **Q10** measured — proof/results.json → rules[topic_consistency].ppvAt (what a fire is worth at 1%, 5%, 20% and 50% prevalence, from the family's counts)
- **Q11** measured — proof/composite-results.json → perClass[off_task] (recall on composed cases and the 24 real transcripts where the class is present)
- **Q12** measurable — pair rule fires with the judge's dimensions on one corpus (needs a key)
- **Q13** measurable — run the rules over the judge corpus and the judge over the rule corpus; publish the agreement per pair (needs a key)

### `no_pii` (the built-in rules)

- **Q1** measured — proof/results.json → rules[no_pii] (precision, recall and F1 on 93 labelled cases with Wilson and credible 95% intervals; in-sample, same-model labelled until the blind label lands)
- **Q2** measured — proof/results.json → transforms.rows[rule=no_pii] (recall under 7 evasion transforms inside the evidence span, plus the false-positive and false-negative ids in proof/RESULTS.md)
- **Q3** stated — list_rules → kind: detection, mechanism: pattern; proof/corpus → definition (a detection or inference: the family measures detection of the named failure classes)
- **Q4** stated — every result since 0.9.0 carries kind and mechanism (the kind label names the claim; what it appears to measure beyond that is not measured)
- **Q5** measurable — proof/lib/composite-report.ts calibration, per rule score (a per-rule reliability curve over the composite corpus is the harness; only the composer is calibrated today)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check regenerates the file byte for byte in CI on every pull request (a pure function of its input; the committed numbers are the code's)
- **Q9** measured — proof/results.json → transforms.rows[rule=no_pii] (the same transforms table: zero-width, homoglyph, fullwidth, no-break space, tab, line break, case)
- **Q10** measured — proof/results.json → rules[no_pii].ppvAt (what a fire is worth at 1%, 5%, 20% and 50% prevalence, from the family's counts)
- **Q11** measured — proof/composite-results.json → perClass[pii_leak, credential_leak] (recall on composed cases and the 24 real transcripts where the class is present; per-entity recall in results.json → entities)
- **Q12** measurable — pair rule fires with the judge's dimensions on one corpus (needs a key)
- **Q13** measurable — run the rules over the judge corpus and the judge over the rule corpus; publish the agreement per pair (needs a key)

### `no_blocklist_words` (the built-in rules)

- **Q1** measured — proof/results.json → rules[no_blocklist_words] (precision, recall and F1 on 32 labelled cases with Wilson and credible 95% intervals; in-sample, same-model labelled until the blind label lands)
- **Q2** measured — proof/results.json → transforms.rows[rule=no_blocklist_words] (recall under 7 evasion transforms inside the evidence span, plus the false-positive and false-negative ids in proof/RESULTS.md)
- **Q3** stated — list_rules → kind: policy, mechanism: pattern; proof/corpus → definition (a measurement or policy: the proof family measures conformance to the stated formula, not detection of a failure)
- **Q4** stated — every result since 0.9.0 carries kind and mechanism (the kind label says it is a formula, so it cannot appear to be a detector)
- **Q5** measurable — proof/lib/composite-report.ts calibration, per rule score (a per-rule reliability curve over the composite corpus is the harness; only the composer is calibrated today)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check regenerates the file byte for byte in CI on every pull request (a pure function of its input; the committed numbers are the code's)
- **Q9** measured — proof/results.json → transforms.rows[rule=no_blocklist_words] (the same transforms table: zero-width, homoglyph, fullwidth, no-break space, tab, line break, case)
- **Q10** measured — proof/results.json → rules[no_blocklist_words].ppvAt (what a fire is worth at 1%, 5%, 20% and 50% prevalence, from the family's counts)
- **Q11** measurable — a labelled outcome the formula should track (a formula's family measures conformance; correlation with an outcome needs cases labelled by the outcome)
- **Q12** measurable — pair rule fires with the judge's dimensions on one corpus (needs a key)
- **Q13** measurable — run the rules over the judge corpus and the judge over the rule corpus; publish the agreement per pair (needs a key)

### `no_injection_patterns` (the built-in rules)

- **Q1** measured — proof/results.json → rules[no_injection_patterns] (precision, recall and F1 on 90 labelled cases with Wilson and credible 95% intervals; in-sample, same-model labelled until the blind label lands)
- **Q2** measured — proof/results.json → transforms.rows[rule=no_injection_patterns] (recall under 7 evasion transforms inside the evidence span, plus the false-positive and false-negative ids in proof/RESULTS.md)
- **Q3** stated — list_rules → kind: detection, mechanism: pattern; proof/corpus → definition (a detection or inference: the family measures detection of the named failure classes)
- **Q4** stated — every result since 0.9.0 carries kind and mechanism (the kind label names the claim; what it appears to measure beyond that is not measured)
- **Q5** measurable — proof/lib/composite-report.ts calibration, per rule score (a per-rule reliability curve over the composite corpus is the harness; only the composer is calibrated today)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check regenerates the file byte for byte in CI on every pull request (a pure function of its input; the committed numbers are the code's)
- **Q9** measured — proof/results.json → transforms.rows[rule=no_injection_patterns] (the same transforms table: zero-width, homoglyph, fullwidth, no-break space, tab, line break, case)
- **Q10** measured — proof/results.json → rules[no_injection_patterns].ppvAt (what a fire is worth at 1%, 5%, 20% and 50% prevalence, from the family's counts)
- **Q11** measured — proof/composite-results.json → perClass[injection] (recall on composed cases and the 24 real transcripts where the class is present)
- **Q12** measurable — pair rule fires with the judge's dimensions on one corpus (needs a key)
- **Q13** measurable — run the rules over the judge corpus and the judge over the rule corpus; publish the agreement per pair (needs a key)

### `no_stub_output` (the built-in rules)

- **Q1** measured — proof/results.json → rules[no_stub_output] (precision, recall and F1 on 89 labelled cases with Wilson and credible 95% intervals; in-sample, same-model labelled until the blind label lands)
- **Q2** partial — proof/RESULTS.md → misses by case id (every false positive and false negative is named by id; no rate under transforms (the rule reports no span, or is not critical))
- **Q3** stated — list_rules → kind: inference, mechanism: heuristic; proof/corpus → definition (a detection or inference: the family measures detection of the named failure classes)
- **Q4** stated — every result since 0.9.0 carries kind and mechanism (the kind label names the claim; what it appears to measure beyond that is not measured)
- **Q5** measurable — proof/lib/composite-report.ts calibration, per rule score (a per-rule reliability curve over the composite corpus is the harness; only the composer is calibrated today)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check regenerates the file byte for byte in CI on every pull request (a pure function of its input; the committed numbers are the code's)
- **Q9** measurable — proof/lib/transforms.ts extends to any rule that reports a span
- **Q10** measured — proof/results.json → rules[no_stub_output].ppvAt (what a fire is worth at 1%, 5%, 20% and 50% prevalence, from the family's counts)
- **Q11** measured — proof/composite-results.json → perClass[stub] (recall on composed cases and the 24 real transcripts where the class is present)
- **Q12** measurable — pair rule fires with the judge's dimensions on one corpus (needs a key)
- **Q13** measurable — run the rules over the judge corpus and the judge over the rule corpus; publish the agreement per pair (needs a key)

### `no_hallucination_markers` (the built-in rules)

- **Q1** measured — proof/results.json → rules[no_hallucination_markers] (precision, recall and F1 on 90 labelled cases with Wilson and credible 95% intervals; in-sample, same-model labelled until the blind label lands)
- **Q2** partial — proof/RESULTS.md → misses by case id (every false positive and false negative is named by id; no rate under transforms (the rule reports no span, or is not critical))
- **Q3** stated — list_rules → kind: inference, mechanism: heuristic; proof/corpus → definition (a detection or inference: the family measures detection of the named failure classes)
- **Q4** stated — every result since 0.9.0 carries kind and mechanism (the kind label names the claim; what it appears to measure beyond that is not measured)
- **Q5** measurable — proof/lib/composite-report.ts calibration, per rule score (a per-rule reliability curve over the composite corpus is the harness; only the composer is calibrated today)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check regenerates the file byte for byte in CI on every pull request (a pure function of its input; the committed numbers are the code's)
- **Q9** measurable — proof/lib/transforms.ts extends to any rule that reports a span
- **Q10** measured — proof/results.json → rules[no_hallucination_markers].ppvAt (what a fire is worth at 1%, 5%, 20% and 50% prevalence, from the family's counts)
- **Q11** measured — proof/composite-results.json → perClass[fabrication] (recall on composed cases and the 24 real transcripts where the class is present)
- **Q12** measurable — pair rule fires with the judge's dimensions on one corpus (needs a key)
- **Q13** measurable — run the rules over the judge corpus and the judge over the rule corpus; publish the agreement per pair (needs a key)

### `no_silent_tool_failure` (the built-in rules)

- **Q1** measured — proof/results.json → rules[no_silent_tool_failure] (precision, recall and F1 on 30 labelled cases with Wilson and credible 95% intervals; in-sample, same-model labelled until the blind label lands)
- **Q2** partial — proof/RESULTS.md → misses by case id (every false positive and false negative is named by id; no rate under transforms (the rule reports no span, or is not critical))
- **Q3** stated — list_rules → kind: inference, mechanism: heuristic; proof/corpus → definition (a detection or inference: the family measures detection of the named failure classes)
- **Q4** stated — every result since 0.9.0 carries kind and mechanism (the kind label names the claim; what it appears to measure beyond that is not measured)
- **Q5** measurable — proof/lib/composite-report.ts calibration, per rule score (a per-rule reliability curve over the composite corpus is the harness; only the composer is calibrated today)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check regenerates the file byte for byte in CI on every pull request (a pure function of its input; the committed numbers are the code's)
- **Q9** measurable — proof/lib/transforms.ts extends to any rule that reports a span
- **Q10** measured — proof/results.json → rules[no_silent_tool_failure].ppvAt (what a fire is worth at 1%, 5%, 20% and 50% prevalence, from the family's counts)
- **Q11** measured — proof/composite-results.json → perClass[silent_tool_failure] (recall on composed cases and the 24 real transcripts where the class is present)
- **Q12** measurable — pair rule fires with the judge's dimensions on one corpus (needs a key)
- **Q13** measurable — run the rules over the judge corpus and the judge over the rule corpus; publish the agreement per pair (needs a key)

### `grounded_in_reads` (the built-in rules)

- **Q1** measured — proof/results.json → rules[grounded_in_reads] (precision, recall and F1 on 32 labelled cases with Wilson and credible 95% intervals; in-sample, same-model labelled until the blind label lands)
- **Q2** partial — proof/RESULTS.md → misses by case id (every false positive and false negative is named by id; no rate under transforms (the rule reports no span, or is not critical))
- **Q3** stated — list_rules → kind: inference, mechanism: heuristic; proof/corpus → definition (a detection or inference: the family measures detection of the named failure classes)
- **Q4** stated — every result since 0.9.0 carries kind and mechanism (the kind label names the claim; what it appears to measure beyond that is not measured)
- **Q5** measurable — proof/lib/composite-report.ts calibration, per rule score (a per-rule reliability curve over the composite corpus is the harness; only the composer is calibrated today)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check regenerates the file byte for byte in CI on every pull request (a pure function of its input; the committed numbers are the code's)
- **Q9** measurable — proof/lib/transforms.ts extends to any rule that reports a span
- **Q10** measured — proof/results.json → rules[grounded_in_reads].ppvAt (what a fire is worth at 1%, 5%, 20% and 50% prevalence, from the family's counts)
- **Q11** measured — proof/composite-results.json → perClass[ungrounded] (recall on composed cases and the 24 real transcripts where the class is present)
- **Q12** measurable — pair rule fires with the judge's dimensions on one corpus (needs a key)
- **Q13** measurable — run the rules over the judge corpus and the judge over the rule corpus; publish the agreement per pair (needs a key)

### `cost_under_threshold` (the built-in rules)

- **Q1** measured — proof/results.json → rules[cost_under_threshold] (precision, recall and F1 on 26 labelled cases with Wilson and credible 95% intervals; in-sample, same-model labelled until the blind label lands)
- **Q2** partial — proof/RESULTS.md → misses by case id (every false positive and false negative is named by id; no rate under transforms (the rule reports no span, or is not critical))
- **Q3** stated — list_rules → kind: policy, mechanism: formula; proof/corpus → definition (a measurement or policy: the proof family measures conformance to the stated formula, not detection of a failure)
- **Q4** stated — every result since 0.9.0 carries kind and mechanism (the kind label says it is a formula, so it cannot appear to be a detector)
- **Q5** measurable — proof/lib/composite-report.ts calibration, per rule score (a per-rule reliability curve over the composite corpus is the harness; only the composer is calibrated today)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check regenerates the file byte for byte in CI on every pull request (a pure function of its input; the committed numbers are the code's)
- **Q9** measurable — proof/lib/transforms.ts extends to any rule that reports a span
- **Q10** measured — proof/results.json → rules[cost_under_threshold].ppvAt (what a fire is worth at 1%, 5%, 20% and 50% prevalence, from the family's counts)
- **Q11** measured — proof/composite-results.json → perClass[over_budget] (recall on composed cases and the 24 real transcripts where the class is present)
- **Q12** measurable — pair rule fires with the judge's dimensions on one corpus (needs a key)
- **Q13** measurable — run the rules over the judge corpus and the judge over the rule corpus; publish the agreement per pair (needs a key)

### `verbosity_ratio` (the built-in rules)

- **Q1** measured — proof/results.json → rules[verbosity_ratio] (precision, recall and F1 on 25 labelled cases with Wilson and credible 95% intervals; in-sample, same-model labelled until the blind label lands)
- **Q2** partial — proof/RESULTS.md → misses by case id (every false positive and false negative is named by id; no rate under transforms (the rule reports no span, or is not critical))
- **Q3** stated — list_rules → kind: measurement, mechanism: formula; proof/corpus → definition (a measurement or policy: the proof family measures conformance to the stated formula, not detection of a failure)
- **Q4** stated — every result since 0.9.0 carries kind and mechanism (the kind label says it is a formula, so it cannot appear to be a detector)
- **Q5** measurable — proof/lib/composite-report.ts calibration, per rule score (a per-rule reliability curve over the composite corpus is the harness; only the composer is calibrated today)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check regenerates the file byte for byte in CI on every pull request (a pure function of its input; the committed numbers are the code's)
- **Q9** measurable — proof/lib/transforms.ts extends to any rule that reports a span
- **Q10** measured — proof/results.json → rules[verbosity_ratio].ppvAt (what a fire is worth at 1%, 5%, 20% and 50% prevalence, from the family's counts)
- **Q11** measured — proof/composite-results.json → perClass[over_budget] (recall on composed cases and the 24 real transcripts where the class is present)
- **Q12** measurable — pair rule fires with the judge's dimensions on one corpus (needs a key)
- **Q13** measurable — run the rules over the judge corpus and the judge over the rule corpus; publish the agreement per pair (needs a key)

### `no_tool_loop` (the built-in rules)

- **Q1** measured — proof/results.json → rules[no_tool_loop] (precision, recall and F1 on 28 labelled cases with Wilson and credible 95% intervals; in-sample, same-model labelled until the blind label lands)
- **Q2** partial — proof/RESULTS.md → misses by case id (every false positive and false negative is named by id; no rate under transforms (the rule reports no span, or is not critical))
- **Q3** stated — list_rules → kind: detection, mechanism: formula; proof/corpus → definition (a detection or inference: the family measures detection of the named failure classes)
- **Q4** stated — every result since 0.9.0 carries kind and mechanism (the kind label names the claim; what it appears to measure beyond that is not measured)
- **Q5** measurable — proof/lib/composite-report.ts calibration, per rule score (a per-rule reliability curve over the composite corpus is the harness; only the composer is calibrated today)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check regenerates the file byte for byte in CI on every pull request (a pure function of its input; the committed numbers are the code's)
- **Q9** measurable — proof/lib/transforms.ts extends to any rule that reports a span
- **Q10** measured — proof/results.json → rules[no_tool_loop].ppvAt (what a fire is worth at 1%, 5%, 20% and 50% prevalence, from the family's counts)
- **Q11** measured — proof/composite-results.json → perClass[tool_loop] (recall on composed cases and the 24 real transcripts where the class is present)
- **Q12** measurable — pair rule fires with the judge's dimensions on one corpus (needs a key)
- **Q13** measurable — run the rules over the judge corpus and the judge over the rule corpus; publish the agreement per pair (needs a key)

### `regex_match` (the custom rule types)

- **Q1** measured — proof/results.json → custom.types[regex_match] (conformance to the documented definition under a declared config on 24 cases)
- **Q2** stated — proof/corpus/custom/regex_match.json → definition and boundary cases (the definition names the limit; the family holds the boundary cases)
- **Q3** stated — proof/corpus/custom/regex_match.json → definition, config (the author's own constraint under the config the family declares)
- **Q4** stated — proof/corpus/custom/regex_match.json → definition (a constraint, not a detector)
- **Q5** n/a (a constraint is not a probability)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check regenerates the file byte for byte in CI on every pull request (deterministic; a regex that exceeds the sandbox budget skips, which the verdict reports as unknown)
- **Q9** measurable — proof/lib/transforms.ts over a pattern type's positives (the same normalisation gap as the built-in pattern rules)
- **Q10** measured — proof/results.json → custom.types[regex_match].ci95.precision (a pass that is wrong is a conformance miss; the precision interval bounds it)
- **Q11** n/a (the outcome is the constraint itself)
- **Q12** n/a (not model-based)
- **Q13** measurable — a second implementation of the same constraint over the same family

### `regex_no_match` (the custom rule types)

- **Q1** measured — proof/results.json → custom.types[regex_no_match] (conformance to the documented definition under a declared config on 24 cases)
- **Q2** stated — proof/corpus/custom/regex_no_match.json → definition and boundary cases (the definition names the limit; the family holds the boundary cases)
- **Q3** stated — proof/corpus/custom/regex_no_match.json → definition, config (the author's own constraint under the config the family declares)
- **Q4** stated — proof/corpus/custom/regex_no_match.json → definition (a constraint, not a detector)
- **Q5** n/a (a constraint is not a probability)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check regenerates the file byte for byte in CI on every pull request (deterministic; a regex that exceeds the sandbox budget skips, which the verdict reports as unknown)
- **Q9** measurable — proof/lib/transforms.ts over a pattern type's positives (the same normalisation gap as the built-in pattern rules)
- **Q10** measured — proof/results.json → custom.types[regex_no_match].ci95.precision (a pass that is wrong is a conformance miss; the precision interval bounds it)
- **Q11** n/a (the outcome is the constraint itself)
- **Q12** n/a (not model-based)
- **Q13** measurable — a second implementation of the same constraint over the same family

### `min_length` (the custom rule types)

- **Q1** measured — proof/results.json → custom.types[min_length] (conformance to the documented definition under a declared config on 24 cases)
- **Q2** stated — proof/corpus/custom/min_length.json → definition and boundary cases (the definition names the limit; the family holds the boundary cases)
- **Q3** stated — proof/corpus/custom/min_length.json → definition, config (the author's own constraint under the config the family declares)
- **Q4** stated — proof/corpus/custom/min_length.json → definition (a constraint, not a detector)
- **Q5** n/a (a constraint is not a probability)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check regenerates the file byte for byte in CI on every pull request (deterministic)
- **Q9** n/a (arithmetic over the whole output)
- **Q10** measured — proof/results.json → custom.types[min_length].ci95.precision (a pass that is wrong is a conformance miss; the precision interval bounds it)
- **Q11** n/a (the outcome is the constraint itself)
- **Q12** n/a (not model-based)
- **Q13** measurable — a second implementation of the same constraint over the same family

### `max_length` (the custom rule types)

- **Q1** measured — proof/results.json → custom.types[max_length] (conformance to the documented definition under a declared config on 24 cases)
- **Q2** stated — proof/corpus/custom/max_length.json → definition and boundary cases (the definition names the limit; the family holds the boundary cases)
- **Q3** stated — proof/corpus/custom/max_length.json → definition, config (the author's own constraint under the config the family declares)
- **Q4** stated — proof/corpus/custom/max_length.json → definition (a constraint, not a detector)
- **Q5** n/a (a constraint is not a probability)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check regenerates the file byte for byte in CI on every pull request (deterministic)
- **Q9** n/a (arithmetic over the whole output)
- **Q10** measured — proof/results.json → custom.types[max_length].ci95.precision (a pass that is wrong is a conformance miss; the precision interval bounds it)
- **Q11** n/a (the outcome is the constraint itself)
- **Q12** n/a (not model-based)
- **Q13** measurable — a second implementation of the same constraint over the same family

### `contains_keywords` (the custom rule types)

- **Q1** measured — proof/results.json → custom.types[contains_keywords] (conformance to the documented definition under a declared config on 24 cases)
- **Q2** stated — proof/corpus/custom/contains_keywords.json → definition and boundary cases (the definition names the limit; the family holds the boundary cases)
- **Q3** stated — proof/corpus/custom/contains_keywords.json → definition, config (the author's own constraint under the config the family declares)
- **Q4** stated — proof/corpus/custom/contains_keywords.json → definition (a constraint, not a detector)
- **Q5** n/a (a constraint is not a probability)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check regenerates the file byte for byte in CI on every pull request (deterministic; a regex that exceeds the sandbox budget skips, which the verdict reports as unknown)
- **Q9** measurable — proof/lib/transforms.ts over a pattern type's positives (the same normalisation gap as the built-in pattern rules)
- **Q10** measured — proof/results.json → custom.types[contains_keywords].ci95.precision (a pass that is wrong is a conformance miss; the precision interval bounds it)
- **Q11** n/a (the outcome is the constraint itself)
- **Q12** n/a (not model-based)
- **Q13** measurable — a second implementation of the same constraint over the same family

### `excludes_keywords` (the custom rule types)

- **Q1** measured — proof/results.json → custom.types[excludes_keywords] (conformance to the documented definition under a declared config on 24 cases)
- **Q2** stated — proof/corpus/custom/excludes_keywords.json → definition and boundary cases (the definition names the limit; the family holds the boundary cases)
- **Q3** stated — proof/corpus/custom/excludes_keywords.json → definition, config (the author's own constraint under the config the family declares)
- **Q4** stated — proof/corpus/custom/excludes_keywords.json → definition (a constraint, not a detector)
- **Q5** n/a (a constraint is not a probability)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check regenerates the file byte for byte in CI on every pull request (deterministic; a regex that exceeds the sandbox budget skips, which the verdict reports as unknown)
- **Q9** measurable — proof/lib/transforms.ts over a pattern type's positives (the same normalisation gap as the built-in pattern rules)
- **Q10** measured — proof/results.json → custom.types[excludes_keywords].ci95.precision (a pass that is wrong is a conformance miss; the precision interval bounds it)
- **Q11** n/a (the outcome is the constraint itself)
- **Q12** n/a (not model-based)
- **Q13** measurable — a second implementation of the same constraint over the same family

### `json_schema` (the custom rule types)

- **Q1** measured — proof/results.json → custom.types[json_schema] (conformance to the documented definition under a declared config on 27 cases)
- **Q2** stated — proof/corpus/custom/json_schema.json → definition and boundary cases (the definition names the limit; the family holds the boundary cases)
- **Q3** stated — proof/corpus/custom/json_schema.json → definition, config (the author's own constraint under the config the family declares)
- **Q4** stated — proof/corpus/custom/json_schema.json → definition (a constraint, not a detector)
- **Q5** n/a (a constraint is not a probability)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check regenerates the file byte for byte in CI on every pull request (deterministic)
- **Q9** n/a (arithmetic over the whole output)
- **Q10** measured — proof/results.json → custom.types[json_schema].ci95.precision (a pass that is wrong is a conformance miss; the precision interval bounds it)
- **Q11** n/a (the outcome is the constraint itself)
- **Q12** n/a (not model-based)
- **Q13** measurable — a second implementation of the same constraint over the same family

### `cost_threshold` (the custom rule types)

- **Q1** measured — proof/results.json → custom.types[cost_threshold] (conformance to the documented definition under a declared config on 24 cases)
- **Q2** stated — proof/corpus/custom/cost_threshold.json → definition and boundary cases (the definition names the limit; the family holds the boundary cases)
- **Q3** stated — proof/corpus/custom/cost_threshold.json → definition, config (the author's own constraint under the config the family declares)
- **Q4** stated — proof/corpus/custom/cost_threshold.json → definition (a constraint, not a detector)
- **Q5** n/a (a constraint is not a probability)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check regenerates the file byte for byte in CI on every pull request (deterministic)
- **Q9** n/a (arithmetic over the whole output)
- **Q10** measured — proof/results.json → custom.types[cost_threshold].ci95.precision (a pass that is wrong is a conformance miss; the precision interval bounds it)
- **Q11** n/a (the outcome is the constraint itself)
- **Q12** n/a (not model-based)
- **Q13** measurable — a second implementation of the same constraint over the same family

### `accuracy` (the LLM-judge templates)

- **Q1** measurable — npm run proof:judge — 165 cases across the five templates under a cost cap (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q2** measurable — the same run names the misses by id (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q3** stated — src/eval/llm-judge/templates → dimensions and passThreshold (the template names its dimensions and the threshold a score is read against)
- **Q4** measurable — compare the model's self-reported pass with the threshold verdict on the same run (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q5** measurable — reliability bins, Brier and ECE per template with intervals (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q6** measurable — three committed paraphrases per template, pairwise agreement and score correlation (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q7** measurable — both default providers on the same cases; agreement and the disagreement list (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q8** measurable — repeat the judge run k times over the same cases; flip rate per template with an interval (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q9** measurable — injection twins per template; length, confidence and forged-close-tag axes (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q10** measurable — the self-reported pass against the score on the same run (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q11** measurable — human agreement on the judged cases (the blind label instrument) (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q12** measurable — pair each template's dimensions with the rules that map to them (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q13** measurable — the judge over the rule corpus, the rules over the judge corpus (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)

### `helpfulness` (the LLM-judge templates)

- **Q1** measurable — npm run proof:judge — 165 cases across the five templates under a cost cap (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q2** measurable — the same run names the misses by id (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q3** stated — src/eval/llm-judge/templates → dimensions and passThreshold (the template names its dimensions and the threshold a score is read against)
- **Q4** measurable — compare the model's self-reported pass with the threshold verdict on the same run (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q5** measurable — reliability bins, Brier and ECE per template with intervals (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q6** measurable — three committed paraphrases per template, pairwise agreement and score correlation (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q7** measurable — both default providers on the same cases; agreement and the disagreement list (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q8** measurable — repeat the judge run k times over the same cases; flip rate per template with an interval (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q9** measurable — injection twins per template; length, confidence and forged-close-tag axes (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q10** measurable — the self-reported pass against the score on the same run (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q11** measurable — human agreement on the judged cases (the blind label instrument) (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q12** measurable — pair each template's dimensions with the rules that map to them (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q13** measurable — the judge over the rule corpus, the rules over the judge corpus (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)

### `safety` (the LLM-judge templates)

- **Q1** measurable — npm run proof:judge — 165 cases across the five templates under a cost cap (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q2** measurable — the same run names the misses by id (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q3** stated — src/eval/llm-judge/templates → dimensions and passThreshold (the template names its dimensions and the threshold a score is read against)
- **Q4** measurable — compare the model's self-reported pass with the threshold verdict on the same run (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q5** measurable — reliability bins, Brier and ECE per template with intervals (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q6** measurable — three committed paraphrases per template, pairwise agreement and score correlation (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q7** measurable — both default providers on the same cases; agreement and the disagreement list (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q8** measurable — repeat the judge run k times over the same cases; flip rate per template with an interval (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q9** measurable — injection twins per template; length, confidence and forged-close-tag axes (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q10** measurable — the self-reported pass against the score on the same run (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q11** measurable — human agreement on the judged cases (the blind label instrument) (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q12** measurable — pair each template's dimensions with the rules that map to them (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q13** measurable — the judge over the rule corpus, the rules over the judge corpus (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)

### `correctness` (the LLM-judge templates)

- **Q1** measurable — npm run proof:judge — 165 cases across the five templates under a cost cap (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q2** measurable — the same run names the misses by id (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q3** stated — src/eval/llm-judge/templates → dimensions and passThreshold (the template names its dimensions and the threshold a score is read against)
- **Q4** measurable — compare the model's self-reported pass with the threshold verdict on the same run (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q5** measurable — reliability bins, Brier and ECE per template with intervals (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q6** measurable — three committed paraphrases per template, pairwise agreement and score correlation (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q7** measurable — both default providers on the same cases; agreement and the disagreement list (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q8** measurable — repeat the judge run k times over the same cases; flip rate per template with an interval (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q9** measurable — injection twins per template; length, confidence and forged-close-tag axes (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q10** measurable — the self-reported pass against the score on the same run (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q11** measurable — human agreement on the judged cases (the blind label instrument) (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q12** measurable — pair each template's dimensions with the rules that map to them (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q13** measurable — the judge over the rule corpus, the rules over the judge corpus (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)

### `faithfulness` (the LLM-judge templates)

- **Q1** measurable — npm run proof:judge — 165 cases across the five templates under a cost cap (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q2** measurable — the same run names the misses by id (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q3** stated — src/eval/llm-judge/templates → dimensions and passThreshold (the template names its dimensions and the threshold a score is read against)
- **Q4** measurable — compare the model's self-reported pass with the threshold verdict on the same run (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q5** measurable — reliability bins, Brier and ECE per template with intervals (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q6** measurable — three committed paraphrases per template, pairwise agreement and score correlation (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q7** measurable — both default providers on the same cases; agreement and the disagreement list (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q8** measurable — repeat the judge run k times over the same cases; flip rate per template with an interval (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q9** measurable — injection twins per template; length, confidence and forged-close-tag axes (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q10** measurable — the self-reported pass against the score on the same run (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q11** measurable — human agreement on the judged cases (the blind label instrument) (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q12** measurable — pair each template's dimensions with the rules that map to them (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)
- **Q13** measurable — the judge over the rule corpus, the rules over the judge corpus (needs a judge key that the founder or a user supplies; proof/judge-results.json is pending)

### `verify_citations` (the citation verifier)

- **Q1** measurable — npm run proof:judge — the citation cases (needs a judge key; the 17 citation cases run under the same runner)
- **Q2** measurable — the same run names the misses (needs a judge key; the 17 citation cases run under the same runner)
- **Q3** stated — verify_citations → supported / judged; resolution off by default (what the tool computes is stated in its description and docs)
- **Q4** measurable — a dead URL with fetch off passes; the verifier split (resolves vs supports) is the fix and the measurement (needs a judge key; the 17 citation cases run under the same runner)
- **Q5** measurable — about a hundred judged citations are needed for bins (underpowered at the current corpus size)
- **Q6** measurable — paraphrased support prompts (needs a judge key; the 17 citation cases run under the same runner)
- **Q7** measurable — both providers (needs a judge key; the 17 citation cases run under the same runner)
- **Q8** measurable — repeats (needs a judge key; the 17 citation cases run under the same runner)
- **Q9** measurable — fetch off: any output with citations passes; measured once the split lands (needs a judge key; the 17 citation cases run under the same runner)
- **Q10** measurable — passed with a null score whenever nothing resolved (needs a judge key; the 17 citation cases run under the same runner)
- **Q11** measurable — human agreement on support judgements (needs a judge key; the 17 citation cases run under the same runner)
- **Q12** measurable — citation_resolves (deterministic) beside citation_supports (judgment) on one case
- **Q13** measurable — the groundedness triple: signals, judge, citations

### `the verdict composer (passed)` (the verdict composer)

- **Q1** measured — proof/composite-results.json → legacy.test, risk.test, realTranscripts (verdict accuracy against shouldShip on the test split and on the 24 real transcripts, for the legacy composer and the risk (per-output prior) composer, with Wilson intervals and the Newcombe interval on the difference)
- **Q2** measured — proof/composite-results.json → legacy.test.falseBlock, legacy.test.missedBlock, sweep (false blocks on clean cases and missed blocks on must-not-ship cases, separately; the threshold sweep on the dev split)
- **Q3** stated — proof/composite-results.json → method.legacy, method.risk (the legacy arithmetic and the risk model are stated in the file)
- **Q4** measured — proof/composite-results.json → legacy.test.missedBlock (the share of must-not-ship outputs the legacy verdict passes is the measurement of a score that appears to be a quality gradient)
- **Q5** measured — proof/composite-results.json → legacy.test.calibration, risk.test.calibration, sweep (Brier and expected calibration error over ten bins for the legacy score read as P(bad) and for p_bad; the utility-optimal threshold on the dev split beside the shipped one)
- **Q6** n/a (deterministic)
- **Q7** n/a (deterministic)
- **Q8** measured — npm run proof -- --check --composite regenerates the file byte for byte in CI
- **Q9** measurable — a critical rule defeated by the output (the regex budget) reads as unknown from 0.10.0; measured by a composite case that stalls a critical pattern
- **Q10** measured — proof/composite-results.json → legacy.test.calibration.ece (the calibration error of the legacy score read as a probability is the false-confidence measurement)
- **Q11** measured — proof/composite-results.json → legacy.realTranscripts, risk.realTranscripts (the 24 real transcripts are the out-of-sample line)
- **Q12** measurable — a verdict field for corroboration between rule fires and judge dimensions (needs a key)
- **Q13** measurable — multi-run evaluation of one input; metamorphic pairs over the trace store

