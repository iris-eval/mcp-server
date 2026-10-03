# Iris built-in rules — measured on the proof corpus

Generated 2026-10-03T06:42:53.622Z for v0.19.0 (local generating commit `b56e1829` — branch commits are squashed on merge, so cite the version).
Corpus version `7c27824a2b98` (sha256 of proof/corpus/*.json). Reproduce with `npm run proof`; CI runs `npm run proof -- --check`.

The positive class is the violation: precision = of the outputs the rule failed, the share that were real violations; recall = of the real violations, the share the rule failed. Intervals: Wilson 95% for precision and recall; a seeded percentile bootstrap for F1; beside each, a Dirichlet credible interval that does not collapse to [1, 1] at zero errors (results.json `credible95`). A skipped result (the rule declined to judge) counts as not failed and is listed under "skip". Read proof/README.md before quoting a number — the corpus is synthetic, rule-aware, and labelled by the same model that wrote it.

**What the 26 measured rules show is two different things.** 13 are measured against labels a model gave by reading the failure itself, without running the rule (a synthetic, model-labelled corpus; a human blind label is pending): those numbers measure detection (1 of 13 score F1 1.00). 13 are checked against their own documented definition, applied independently by script or by counting: those numbers show the code implements its formula, not that the formula catches what a reader would call the failure (12 of 13 score F1 1.00). The "Labels" column says which; each family's `labelling` statement says how.

| Rule | Bundle | Labels | n | pos | skip | TP | FP | FN | TN | Precision (95% CI) | Recall (95% CI) | F1 (95% CI) | F1 credible | PPV at 5% / 50% |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|---|---|---|---|---|
| `min_output_length` | completeness | own definition | 24 | 13 | 0 | 13 | 0 | 0 | 11 | 100.0% [77.2, 100.0] | 100.0% [77.2, 100.0] | 1.000 [100.0, 100.0] | [85.9, 99.9] | 100.0% / 100.0% |
| `non_empty_output` | completeness | reader | 28 | 14 | 0 | 12 | 0 | 2 | 14 | 100.0% [75.8, 100.0] | 85.7% [60.1, 96.0] | 0.923 [78.3, 100.0] | [73.4, 97.7] | 100.0% / 100.0% |
| `sentence_count` | completeness | own definition | 24 | 14 | 0 | 14 | 0 | 0 | 10 | 100.0% [78.5, 100.0] | 100.0% [78.5, 100.0] | 1.000 [100.0, 100.0] | [86.9, 99.9] | 100.0% / 100.0% |
| `expected_coverage` | completeness | own definition | 24 | 11 | 0 | 11 | 0 | 0 | 13 | 100.0% [74.1, 100.0] | 100.0% [74.1, 100.0] | 1.000 [100.0, 100.0] | [83.7, 99.9] | 100.0% / 100.0% |
| `valid_tool_arguments` | completeness | own definition | 33 | 15 | 0 | 15 | 0 | 0 | 18 | 100.0% [79.6, 100.0] | 100.0% [79.6, 100.0] | 1.000 [100.0, 100.0] | [88.1, 99.9] | 100.0% / 100.0% |
| `ask_coverage` | completeness | reader | 30 | 13 | 5 | 11 | 4 | 2 | 13 | 73.3% [48.0, 89.1] | 84.6% [57.8, 95.7] | 0.786 [58.3, 92.9] | [56.5, 90.1] | 15.9% / 78.2% |
| `tool_sequence` | completeness | own definition | 51 | 28 | 0 | 28 | 0 | 0 | 23 | 100.0% [87.9, 100.0] | 100.0% [87.9, 100.0] | 1.000 [100.0, 100.0] | [93.5, 100.0] | 100.0% / 100.0% |
| `says_something` | completeness | reader | 242 | 116 | 1 | 23 | 0 | 93 | 126 | 100.0% [85.7, 100.0] | 19.8% [13.6, 28.0] | 0.331 [22.4, 42.8] | [23.4, 42.9] | 100.0% / 100.0% |
| `keyword_overlap` | relevance | own definition | 24 | 11 | 0 | 11 | 0 | 0 | 13 | 100.0% [74.1, 100.0] | 100.0% [74.1, 100.0] | 1.000 [100.0, 100.0] | [83.3, 99.9] | 100.0% / 100.0% |
| `topic_consistency` | relevance | own definition | 24 | 12 | 1 | 11 | 0 | 1 | 12 | 100.0% [74.1, 100.0] | 91.7% [64.6, 98.5] | 0.957 [84.2, 100.0] | [77.2, 99.1] | 100.0% / 100.0% |
| `tool_choice` | relevance | reader | 46 | 20 | 4 | 18 | 0 | 2 | 26 | 100.0% [82.4, 100.0] | 90.0% [69.9, 97.2] | 0.947 [85.7, 100.0] | [81.0, 98.4] | 100.0% / 100.0% |
| `answers_the_ask` | relevance | reader | 45 | 20 | 3 | 20 | 3 | 0 | 22 | 87.0% [67.9, 95.5] | 100.0% [83.9, 100.0] | 0.930 [83.7, 100.0] | [80.6, 97.7] | 30.5% / 89.3% |
| `no_pii` | safety | reader | 101 | 49 | 0 | 44 | 5 | 5 | 47 | 89.8% [78.2, 95.6] | 89.8% [78.2, 95.6] | 0.898 [82.8, 95.6] | [81.3, 94.5] | 33.0% / 90.3% |
| `no_blocklist_words` | safety | reader | 26 | 15 | 0 | 15 | 1 | 0 | 10 | 93.8% [71.7, 98.9] | 100.0% [79.6, 100.0] | 0.968 [88.9, 100.0] | [82.0, 99.3] | 36.7% / 91.7% |
| `no_injection_patterns` | safety | reader | 97 | 45 | 0 | 44 | 1 | 1 | 51 | 97.8% [88.4, 99.6] | 97.8% [88.4, 99.6] | 0.978 [94.3, 100.0] | [92.1, 99.3] | 72.8% / 98.1% |
| `no_stub_output` | safety | reader | 93 | 44 | 0 | 32 | 5 | 12 | 44 | 86.5% [72.0, 94.1] | 72.7% [58.1, 83.7] | 0.790 [68.5, 88.2] | [67.4, 86.8] | 27.3% / 87.7% |
| `no_hallucination_markers` | safety | reader | 90 | 46 | 0 | 34 | 0 | 12 | 44 | 100.0% [89.8, 100.0] | 73.9% [59.7, 84.4] | 0.850 [75.8, 92.1] | [73.7, 91.1] | 100.0% / 100.0% |
| `no_silent_tool_failure` | safety | reader | 74 | 38 | 0 | 29 | 0 | 9 | 36 | 100.0% [88.3, 100.0] | 76.3% [60.8, 87.0] | 0.866 [76.7, 94.0] | [75.8, 93.0] | 100.0% / 100.0% |
| `grounded_in_reads` | safety | reader | 30 | 14 | 0 | 14 | 0 | 0 | 16 | 100.0% [78.5, 100.0] | 100.0% [78.5, 100.0] | 1.000 [100.0, 100.0] | [88.0, 99.9] | 100.0% / 100.0% |
| `no_injection_compliance` | safety | reader | 31 | 14 | 0 | 9 | 0 | 5 | 17 | 100.0% [70.1, 100.0] | 64.3% [38.8, 83.7] | 0.783 [53.8, 95.2] | [53.5, 91.3] | 100.0% / 100.0% |
| `cost_under_threshold` | cost | own definition | 24 | 10 | 2 | 10 | 0 | 0 | 14 | 100.0% [72.3, 100.0] | 100.0% [72.3, 100.0] | 1.000 [100.0, 100.0] | [83.5, 99.9] | 100.0% / 100.0% |
| `verbosity_ratio` | cost | own definition | 24 | 12 | 1 | 12 | 0 | 0 | 12 | 100.0% [75.8, 100.0] | 100.0% [75.8, 100.0] | 1.000 [100.0, 100.0] | [85.3, 99.9] | 100.0% / 100.0% |
| `no_tool_loop` | cost | own definition | 37 | 18 | 0 | 18 | 0 | 0 | 19 | 100.0% [82.4, 100.0] | 100.0% [82.4, 100.0] | 1.000 [100.0, 100.0] | [90.4, 99.9] | 100.0% / 100.0% |
| `max_steps` | cost | own definition | 28 | 12 | 0 | 12 | 0 | 0 | 16 | 100.0% [75.8, 100.0] | 100.0% [75.8, 100.0] | 1.000 [100.0, 100.0] | [85.1, 99.9] | 100.0% / 100.0% |
| `cost_anomaly` | cost | own definition | 27 | 13 | 2 | 13 | 0 | 0 | 14 | 100.0% [77.2, 100.0] | 100.0% [77.2, 100.0] | 1.000 [100.0, 100.0] | [86.2, 99.9] | 100.0% / 100.0% |
| `step_budget` | cost | own definition | 46 | 22 | 0 | 22 | 0 | 0 | 24 | 100.0% [85.1, 100.0] | 100.0% [85.1, 100.0] | 1.000 [100.0, 100.0] | [92.0, 99.9] | 100.0% / 100.0% |

## Misses, by case id

The ids the rule got wrong, so a reader can open the case and judge the miss for themselves. FP = a negative case the rule failed; FN = a positive case the rule passed or skipped.

- `min_output_length` — FP: none · FN: none
- `non_empty_output` — FP: none · FN: nonempty-009, nonempty-010
- `sentence_count` — FP: none · FN: none
- `expected_coverage` — FP: none · FN: none
- `valid_tool_arguments` — FP: none · FN: none
- `ask_coverage` — FP: ask-015, ask-018, ask-019, ask-021 · FN: ask-008, ask-010
- `tool_sequence` — FP: none · FN: none
- `says_something` — FP: none · FN: says-001, says-004, says-005, says-018, says-019, held-002, held-004, held-006, held-008, held-012, held-014, held-018, held-020, held-022, held-024, held-026, held-028, held-032, held-036, held-038, held-040, held-045, held-047, held-051, held-053, held-055, held-057, held-059, held-061, held-063, held-065, held-067, held-069, held-071, held-073, held-075, held-079, held-081, held-083, held-085, held-087, held-089, held-091, held-093, held-095, held-097, held-099, held2-001, held2-003, held2-007, held2-010, held2-011, held2-014, held2-015, held2-018, held2-021, held2-023, held2-027, held2-030, held2-031, held2-034, held2-035, held2-038, held2-039, held2-042, held2-043, held2-046, held2-047, held2-050, held2-051, held2-054, held2-058, held2-059, held2-062, held2-063, held2-066, held2-067, held2-070, held2-071, held2-074, held2-075, held2-078, held2-079, held2-082, held2-083, held2-086, held2-087, held2-090, held2-091, held2-094, held2-095, held2-098, held2-100
- `keyword_overlap` — FP: none · FN: none
- `topic_consistency` — FP: none · FN: topic-021
- `tool_choice` — FP: none · FN: choice-005, choice-016
- `answers_the_ask` — FP: ask-037, ask-043, ask-044 · FN: none
- `no_pii` — FP: pii-008, pii-037, pii-053, pii-062, pii-075 · FN: pii-027, pii-043, pii-067, pii-076, pii-089
- `no_blocklist_words` — FP: blocklist-016 · FN: none
- `no_injection_patterns` — FP: c95 · FN: c08
- `no_stub_output` — FP: stub-018, stub-038, stub-006, stub-075, stub-020 · FN: stub-007, stub-048, stub-022, stub-024, stub-050, stub-060, stub-035, stub-070, stub-078, stub-029, stub-056, stub-084
- `no_hallucination_markers` — FP: none · FN: hall-001, hall-003, hall-017, hall-020, hall-031, hall-040, hall-043, hall-061, hall-070, hall-071, hall-072, hall-084
- `no_silent_tool_failure` — FP: none · FN: silent-012, silent-031, silent-033, silent-034, silent-035, silent-046, silent-047, silent-048, silent-068
- `grounded_in_reads` — FP: none · FN: none
- `no_injection_compliance` — FP: none · FN: injc-008, injc-009, injc-010, injc-011, injc-012
- `cost_under_threshold` — FP: none · FN: none
- `verbosity_ratio` — FP: none · FN: none
- `no_tool_loop` — FP: none · FN: none
- `max_steps` — FP: none · FN: none
- `cost_anomaly` — FP: none · FN: none
- `step_budget` — FP: none · FN: none

## Transforms — do the critical rules survive the evasions a leak arrives in?

for each positive the rule caught untransformed with a span into raw text — the agent output, or a tool output for a trajectory rule — the text inside every reported span is transformed and the rule re-run; recall = still fails / applicable cases, Wilson 95%; a case the rule missed in the clear, or a span the transform does not apply to, is not counted. Rebuilding a tool output clears the derived step list, or the rule would read the untransformed calls through stepsOf and the number would mean nothing.

| Rule | positives | fired untransformed | with a span |
|---|--:|--:|--:|
| `no_pii` | 49 | 44 | 44 |
| `no_injection_patterns` | 45 | 44 | 44 |
| `no_blocklist_words` | 15 | 15 | 15 |
| `no_injection_compliance` | 14 | 9 | 9 |

| Rule | Transform | n | still caught | Recall (95% CI) | dropped |
|---|---|--:|--:|---|---|
| `no_pii` | zero_width | 44 | 44 | 100.0% [92.0, 100.0] | none |
| `no_pii` | homoglyph | 36 | 36 | 100.0% [90.4, 100.0] | none |
| `no_pii` | fullwidth | 44 | 44 | 100.0% [92.0, 100.0] | none |
| `no_pii` | nbsp | 14 | 13 | 92.9% [68.5, 98.7] | pii-096 |
| `no_pii` | tab | 44 | 37 | 84.1% [70.6, 92.1] | pii-004, pii-045, pii-061, pii-068, pii-083, pii-095, pii-096 |
| `no_pii` | linebreak | 44 | 37 | 84.1% [70.6, 92.1] | pii-004, pii-045, pii-061, pii-068, pii-083, pii-095, pii-096 |
| `no_pii` | case | 36 | 28 | 77.8% [61.9, 88.3] | pii-006, pii-011, pii-021, pii-032, pii-045, pii-051, pii-072, pii-083 |
| `no_injection_patterns` | zero_width | 44 | 44 | 100.0% [92.0, 100.0] | none |
| `no_injection_patterns` | homoglyph | 44 | 44 | 100.0% [92.0, 100.0] | none |
| `no_injection_patterns` | fullwidth | 44 | 44 | 100.0% [92.0, 100.0] | none |
| `no_injection_patterns` | nbsp | 37 | 32 | 86.5% [72.0, 94.1] | c03, c18, c66, c72, c80 |
| `no_injection_patterns` | tab | 44 | 40 | 90.9% [78.8, 96.4] | c10, c41, c91, c93 |
| `no_injection_patterns` | linebreak | 44 | 39 | 88.6% [76.0, 95.0] | c10, c37, c41, c91, c93 |
| `no_injection_patterns` | case | 44 | 43 | 97.7% [88.2, 99.6] | c84 |
| `no_blocklist_words` | zero_width | 15 | 15 | 100.0% [79.6, 100.0] | none |
| `no_blocklist_words` | homoglyph | 15 | 15 | 100.0% [79.6, 100.0] | none |
| `no_blocklist_words` | fullwidth | 15 | 15 | 100.0% [79.6, 100.0] | none |
| `no_blocklist_words` | nbsp | 14 | 14 | 100.0% [78.5, 100.0] | none |
| `no_blocklist_words` | tab | 15 | 14 | 93.3% [70.2, 98.8] | blocklist-010 |
| `no_blocklist_words` | linebreak | 15 | 14 | 93.3% [70.2, 98.8] | blocklist-010 |
| `no_blocklist_words` | case | 15 | 15 | 100.0% [79.6, 100.0] | none |
| `no_injection_compliance` | zero_width | 9 | 9 | 100.0% [70.1, 100.0] | none |
| `no_injection_compliance` | homoglyph | 9 | 9 | 100.0% [70.1, 100.0] | none |
| `no_injection_compliance` | fullwidth | 9 | 9 | 100.0% [70.1, 100.0] | none |
| `no_injection_compliance` | nbsp | 9 | 9 | 100.0% [70.1, 100.0] | none |
| `no_injection_compliance` | tab | 9 | 9 | 100.0% [70.1, 100.0] | none |
| `no_injection_compliance` | linebreak | 9 | 9 | 100.0% [70.1, 100.0] | none |
| `no_injection_compliance` | case | 9 | 9 | 100.0% [70.1, 100.0] | none |

- `zero_width` — a zero-width space (U+200B) inserted at the middle of the span
- `homoglyph` — every Latin a e o p c x (and capitals) inside the span replaced by its Cyrillic lookalike
- `fullwidth` — every ASCII letter and digit inside the span replaced by its fullwidth form (NFKC folds it back)
- `nbsp` — every space inside the span replaced by a no-break space (U+00A0)
- `tab` — a tab inserted at the middle of the span
- `linebreak` — a line break inserted at the middle of the span
- `case` — the case of every ASCII letter inside the span swapped

## Recall by entity — `no_pii`

positives carry `entities` named by the case author; caught = the rule failed the case for any reason; named = the evidence named this entity; recall = named / present, Wilson 95% — a case caught for another reason is visible as caught − named.

| Entity | present | caught | named | Recall (95% CI) |
|---|--:|--:|--:|---|
| `ssn` | 4 | 4 | 4 | 100.0% [51.0, 100.0] |
| `credit_card` | 2 | 2 | 2 | 100.0% [34.2, 100.0] |
| `iban` | 1 | 1 | 0 | 0.0% [0.0, 79.3] |
| `phone` | 7 | 7 | 7 | 100.0% [64.6, 100.0] |
| `email` | 12 | 12 | 12 | 100.0% [75.8, 100.0] |
| `dob` | 2 | 2 | 2 | 100.0% [34.2, 100.0] |
| `private_key` | 2 | 2 | 2 | 100.0% [34.2, 100.0] |
| `seed_phrase` | 1 | 1 | 1 | 100.0% [20.6, 100.0] |
| `api_key` | 17 | 15 | 10 | 58.8% [36.0, 78.4] |
| `password` | 3 | 3 | 0 | 0.0% [0.0, 56.1] |
| `address` | 6 | 3 | 0 | 0.0% [0.0, 39.0] |
| `url_token` | 1 | 1 | 0 | 0.0% [0.0, 79.3] |

## Custom rule types — conformance to their documented definitions

each custom rule type built by createCustomRule under the family's config and run on cases labelled by its documented definition; a disagreement is a rule defect or a definition error, never an opinion. Families live in proof/corpus/custom/<type>.json with the config each is measured under.

| Type | config | n | pos | skip | TP | FP | FN | TN | Precision (95% CI) | Recall (95% CI) |
|---|---|--:|--:|--:|--:|--:|--:|--:|---|---|
| `action_policy` | `{"allow":[{"tool":"read_file","args":{"/path":"/workspace/**"}},{"tool":"list_dir","args":{"/path":"/workspace/**"}},{"tool":"web_fetch","args":{"/url":"https://docs.vendor.test/**"}}],"deny":[{"tool":"read_file","args":{"/path":"/workspace/.env*"}},{"tool":"bash"},{"tool":"http_post"}]}` | 30 | 16 | 0 | 16 | 0 | 0 | 14 | 100.0% [80.6, 100.0] | 100.0% [80.6, 100.0] |
| `contains_keywords` | `{"keywords":["refund","policy","days"],"threshold":1}` | 24 | 14 | 0 | 14 | 0 | 0 | 10 | 100.0% [78.5, 100.0] | 100.0% [78.5, 100.0] |
| `cost_threshold` | `{"max_cost":0.05}` | 24 | 12 | 2 | 12 | 0 | 0 | 12 | 100.0% [75.8, 100.0] | 100.0% [75.8, 100.0] |
| `excludes_keywords` | `{"keywords":["guarantee","risk-free"]}` | 24 | 11 | 0 | 11 | 0 | 0 | 13 | 100.0% [74.1, 100.0] | 100.0% [74.1, 100.0] |
| `json_schema` | `{"schema":{"type":"object","properties":{"id":{"type":"string"},"count":{"type":"integer"},"tags":{"type":"array","items":{"type":"string"}},"nested":{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}},"required":["id","count"],"additionalProperties":false}}` | 27 | 15 | 0 | 15 | 0 | 0 | 12 | 100.0% [79.6, 100.0] | 100.0% [79.6, 100.0] |
| `max_length` | `{"max_length":120}` | 24 | 14 | 0 | 14 | 0 | 0 | 10 | 100.0% [78.5, 100.0] | 100.0% [78.5, 100.0] |
| `min_length` | `{"min_length":80}` | 24 | 13 | 0 | 13 | 0 | 0 | 11 | 100.0% [77.2, 100.0] | 100.0% [77.2, 100.0] |
| `regex_match` | `{"pattern":"^Ticket #[0-9]{6}\\b"}` | 24 | 14 | 0 | 14 | 0 | 0 | 10 | 100.0% [78.5, 100.0] | 100.0% [78.5, 100.0] |
| `regex_no_match` | `{"pattern":"\\bTODO\\b"}` | 24 | 12 | 0 | 12 | 0 | 0 | 12 | 100.0% [75.8, 100.0] | 100.0% [75.8, 100.0] |

<!-- latency:start -->
## How long one evaluation takes

EvalEngine.evaluateAll — the call evaluate_output makes — over every case in the proof corpus, 25 warm-up runs discarded, storage excluded. n=1323; p50 0.879 ms, p95 6.237 ms on 12th Gen Intel(R) Core(TM) i9-12900HK (win32/x64, node v24.11.0).

Re-measured on every `npm run proof` and excluded from `--check`: it is a property of the machine, so CI cannot hold it byte-for-byte.

<!-- latency:end -->
Human agreement: pending (human blind label of a 140-case stratified sample, twenty per judgment family).
