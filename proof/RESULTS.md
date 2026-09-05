# Iris built-in rules — measured on the proof corpus

Generated 2026-09-05T19:17:04.462Z for v0.10.0 (local generating commit `ae27615` — branch commits are squashed on merge, so cite the version).
Corpus version `4951762e456d` (sha256 of proof/corpus/*.json). Reproduce with `npm run proof`; CI runs `npm run proof -- --check`.

The positive class is the violation: precision = of the outputs the rule failed, the share that were real violations; recall = of the real violations, the share the rule failed. Intervals: Wilson 95% for precision and recall; a seeded percentile bootstrap for F1; beside each, a Dirichlet credible interval that does not collapse to [1, 1] at zero errors (results.json `credible95`). A skipped result (the rule declined to judge) counts as not failed and is listed under "skip". Read proof/README.md before quoting a number — the corpus is synthetic, rule-aware, and labelled by the same model that wrote it.

| Rule | Bundle | n | pos | skip | TP | FP | FN | TN | Precision (95% CI) | Recall (95% CI) | F1 (95% CI) | F1 credible | PPV at 5% / 50% |
|---|---|--:|--:|--:|--:|--:|--:|--:|---|---|---|---|---|
| `min_output_length` | completeness | 29 | 13 | 0 | 13 | 0 | 0 | 16 | 100.0% [77.2, 100.0] | 100.0% [77.2, 100.0] | 1.000 [100.0, 100.0] | [85.9, 99.9] | 100.0% / 100.0% |
| `non_empty_output` | completeness | 29 | 12 | 0 | 10 | 0 | 2 | 17 | 100.0% [72.3, 100.0] | 83.3% [55.2, 95.3] | 0.909 [73.7, 100.0] | [69.4, 97.3] | 100.0% / 100.0% |
| `sentence_count` | completeness | 30 | 16 | 0 | 16 | 0 | 0 | 14 | 100.0% [80.6, 100.0] | 100.0% [80.6, 100.0] | 1.000 [100.0, 100.0] | [88.6, 99.9] | 100.0% / 100.0% |
| `expected_coverage` | completeness | 29 | 14 | 0 | 14 | 0 | 0 | 15 | 100.0% [78.5, 100.0] | 100.0% [78.5, 100.0] | 1.000 [100.0, 100.0] | [87.0, 99.9] | 100.0% / 100.0% |
| `keyword_overlap` | relevance | 30 | 10 | 0 | 10 | 0 | 0 | 20 | 100.0% [72.3, 100.0] | 100.0% [72.3, 100.0] | 1.000 [100.0, 100.0] | [82.2, 99.9] | 100.0% / 100.0% |
| `topic_consistency` | relevance | 31 | 12 | 1 | 11 | 0 | 1 | 19 | 100.0% [74.1, 100.0] | 91.7% [64.6, 98.5] | 0.957 [83.3, 100.0] | [77.2, 99.1] | 100.0% / 100.0% |
| `no_pii` | safety | 93 | 45 | 0 | 34 | 5 | 11 | 43 | 87.2% [73.3, 94.4] | 75.6% [61.3, 85.8] | 0.809 [70.8, 89.3] | [70.0, 88.2] | 27.6% / 87.9% |
| `no_blocklist_words` | safety | 32 | 15 | 0 | 14 | 1 | 1 | 16 | 93.3% [70.2, 98.8] | 93.3% [70.2, 98.8] | 0.933 [81.5, 100.0] | [76.4, 98.2] | 45.5% / 94.1% |
| `no_injection_patterns` | safety | 90 | 42 | 0 | 41 | 0 | 1 | 48 | 100.0% [91.4, 100.0] | 97.6% [87.7, 99.6] | 0.988 [96.0, 100.0] | [93.2, 99.7] | 100.0% / 100.0% |
| `no_stub_output` | safety | 89 | 42 | 0 | 30 | 5 | 12 | 42 | 85.7% [70.6, 93.7] | 71.4% [56.4, 82.8] | 0.779 [66.7, 87.4] | [65.8, 86.1] | 26.1% / 87.0% |
| `no_hallucination_markers` | safety | 90 | 46 | 0 | 34 | 0 | 12 | 44 | 100.0% [89.8, 100.0] | 73.9% [59.7, 84.4] | 0.850 [75.8, 92.1] | [73.7, 91.1] | 100.0% / 100.0% |
| `no_silent_tool_failure` | safety | 30 | 14 | 0 | 13 | 0 | 1 | 16 | 100.0% [77.2, 100.0] | 92.9% [68.5, 98.7] | 0.963 [86.7, 100.0] | [79.4, 99.1] | 100.0% / 100.0% |
| `cost_under_threshold` | cost | 26 | 10 | 2 | 10 | 0 | 0 | 16 | 100.0% [72.3, 100.0] | 100.0% [72.3, 100.0] | 1.000 [100.0, 100.0] | [83.5, 99.9] | 100.0% / 100.0% |
| `verbosity_ratio` | cost | 25 | 9 | 1 | 9 | 0 | 0 | 16 | 100.0% [70.1, 100.0] | 100.0% [70.1, 100.0] | 1.000 [100.0, 100.0] | [80.8, 99.9] | 100.0% / 100.0% |
| `no_tool_loop` | cost | 28 | 12 | 0 | 12 | 0 | 0 | 16 | 100.0% [75.8, 100.0] | 100.0% [75.8, 100.0] | 1.000 [100.0, 100.0] | [85.5, 99.9] | 100.0% / 100.0% |

## Misses, by case id

The ids the rule got wrong, so a reader can open the case and judge the miss for themselves. FP = a negative case the rule failed; FN = a positive case the rule passed or skipped.

- `min_output_length` — FP: none · FN: none
- `non_empty_output` — FP: none · FN: nonempty-009, nonempty-010
- `sentence_count` — FP: none · FN: none
- `expected_coverage` — FP: none · FN: none
- `keyword_overlap` — FP: none · FN: none
- `topic_consistency` — FP: none · FN: topic-021
- `no_pii` — FP: pii-008, pii-037, pii-053, pii-062, pii-075 · FN: pii-001, pii-004, pii-027, pii-041, pii-043, pii-061, pii-067, pii-071, pii-076, pii-088, pii-089
- `no_blocklist_words` — FP: blocklist-016 · FN: blocklist-010
- `no_injection_patterns` — FP: none · FN: c08
- `no_stub_output` — FP: stub-018, stub-038, stub-006, stub-075, stub-020 · FN: stub-007, stub-048, stub-022, stub-024, stub-050, stub-060, stub-035, stub-070, stub-078, stub-029, stub-056, stub-084
- `no_hallucination_markers` — FP: none · FN: hall-001, hall-003, hall-017, hall-020, hall-031, hall-040, hall-043, hall-061, hall-070, hall-071, hall-072, hall-084
- `no_silent_tool_failure` — FP: none · FN: silent-012
- `cost_under_threshold` — FP: none · FN: none
- `verbosity_ratio` — FP: none · FN: none
- `no_tool_loop` — FP: none · FN: none

## Transforms — do the critical rules survive the evasions a leak arrives in?

for each positive the rule caught untransformed with a span into the raw output, the text inside every reported span is transformed and the rule re-run; recall = still fails / applicable cases, Wilson 95%; a case the rule missed in the clear, or a span the transform does not apply to, is not counted.

| Rule | positives | fired untransformed | with a span |
|---|--:|--:|--:|
| `no_pii` | 45 | 34 | 34 |
| `no_injection_patterns` | 42 | 41 | 41 |
| `no_blocklist_words` | 15 | 14 | 14 |

| Rule | Transform | n | still caught | Recall (95% CI) | dropped |
|---|---|--:|--:|---|---|
| `no_pii` | zero_width | 34 | 34 | 100.0% [89.8, 100.0] | none |
| `no_pii` | homoglyph | 27 | 27 | 100.0% [87.5, 100.0] | none |
| `no_pii` | fullwidth | 34 | 34 | 100.0% [89.8, 100.0] | none |
| `no_pii` | nbsp | 11 | 11 | 100.0% [74.1, 100.0] | none |
| `no_pii` | tab | 34 | 18 | 52.9% [36.7, 68.5] | pii-009, pii-010, pii-011, pii-015, pii-018, pii-020, pii-033, pii-035, pii-045, pii-048, pii-051, pii-064, pii-068, pii-081, pii-083, pii-087 |
| `no_pii` | linebreak | 34 | 13 | 38.2% [23.9, 55.0] | pii-006, pii-009, pii-010, pii-011, pii-015, pii-018, pii-020, pii-032, pii-033, pii-035, pii-045, pii-048, pii-051, pii-056, pii-057, pii-064, pii-068, pii-074, pii-081, pii-083, pii-087 |
| `no_pii` | case | 27 | 15 | 55.6% [37.3, 72.4] | pii-006, pii-011, pii-021, pii-023, pii-032, pii-045, pii-048, pii-051, pii-068, pii-072, pii-081, pii-083 |
| `no_injection_patterns` | zero_width | 41 | 41 | 100.0% [91.4, 100.0] | none |
| `no_injection_patterns` | homoglyph | 41 | 41 | 100.0% [91.4, 100.0] | none |
| `no_injection_patterns` | fullwidth | 41 | 41 | 100.0% [91.4, 100.0] | none |
| `no_injection_patterns` | nbsp | 36 | 36 | 100.0% [90.4, 100.0] | none |
| `no_injection_patterns` | tab | 41 | 18 | 43.9% [29.9, 59.0] | c05, c10, c14, c18, c20, c22, c24, c31, c33, c41, c45, c48, c50, c54, c56, c61, c63, c66, c70, c74, c76, c80, c89 |
| `no_injection_patterns` | linebreak | 41 | 15 | 36.6% [23.6, 51.9] | c03, c05, c10, c14, c16, c18, c20, c22, c24, c31, c33, c37, c41, c45, c48, c50, c54, c56, c61, c63, c66, c70, c74, c76, c80, c89 |
| `no_injection_patterns` | case | 41 | 40 | 97.6% [87.4, 99.6] | c84 |
| `no_blocklist_words` | zero_width | 14 | 14 | 100.0% [78.5, 100.0] | none |
| `no_blocklist_words` | homoglyph | 14 | 14 | 100.0% [78.5, 100.0] | none |
| `no_blocklist_words` | fullwidth | 14 | 14 | 100.0% [78.5, 100.0] | none |
| `no_blocklist_words` | nbsp | 13 | 13 | 100.0% [77.2, 100.0] | none |
| `no_blocklist_words` | tab | 14 | 1 | 7.1% [1.3, 31.5] | blocklist-001, blocklist-002, blocklist-003, blocklist-004, blocklist-005, blocklist-006, blocklist-007, blocklist-008, blocklist-009, blocklist-011, blocklist-013, blocklist-014, blocklist-015 |
| `no_blocklist_words` | linebreak | 14 | 0 | 0.0% [0.0, 21.5] | blocklist-001, blocklist-002, blocklist-003, blocklist-004, blocklist-005, blocklist-006, blocklist-007, blocklist-008, blocklist-009, blocklist-011, blocklist-012, blocklist-013, blocklist-014, blocklist-015 |
| `no_blocklist_words` | case | 14 | 14 | 100.0% [78.5, 100.0] | none |

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
| `ssn` | 3 | 3 | 3 | 100.0% [43.9, 100.0] |
| `credit_card` | 2 | 2 | 2 | 100.0% [34.2, 100.0] |
| `iban` | 1 | 1 | 0 | 0.0% [0.0, 79.3] |
| `phone` | 7 | 7 | 7 | 100.0% [64.6, 100.0] |
| `email` | 11 | 11 | 11 | 100.0% [74.1, 100.0] |
| `dob` | 1 | 1 | 1 | 100.0% [20.6, 100.0] |
| `private_key` | 2 | 2 | 2 | 100.0% [34.2, 100.0] |
| `seed_phrase` | 1 | 1 | 1 | 100.0% [20.6, 100.0] |
| `api_key` | 17 | 10 | 10 | 58.8% [36.0, 78.4] |
| `password` | 2 | 2 | 0 | 0.0% [0.0, 65.8] |
| `address` | 6 | 3 | 0 | 0.0% [0.0, 39.0] |
| `url_token` | 1 | 0 | 0 | 0.0% [0.0, 79.3] |

## Custom rule types — conformance to their documented definitions

each custom rule type built by createCustomRule under the family's config and run on cases labelled by its documented definition; a disagreement is a rule defect or a definition error, never an opinion. Families live in proof/corpus/custom/<type>.json with the config each is measured under.

| Type | config | n | pos | skip | TP | FP | FN | TN | Precision (95% CI) | Recall (95% CI) |
|---|---|--:|--:|--:|--:|--:|--:|--:|---|---|
| `contains_keywords` | `{"keywords":["refund","policy","days"],"threshold":1}` | 24 | 14 | 0 | 14 | 0 | 0 | 10 | 100.0% [78.5, 100.0] | 100.0% [78.5, 100.0] |
| `cost_threshold` | `{"max_cost":0.05}` | 24 | 12 | 2 | 12 | 0 | 0 | 12 | 100.0% [75.8, 100.0] | 100.0% [75.8, 100.0] |
| `excludes_keywords` | `{"keywords":["guarantee","risk-free"]}` | 24 | 11 | 0 | 11 | 0 | 0 | 13 | 100.0% [74.1, 100.0] | 100.0% [74.1, 100.0] |
| `json_schema` | `{}` | 25 | 12 | 0 | 12 | 0 | 0 | 13 | 100.0% [75.8, 100.0] | 100.0% [75.8, 100.0] |
| `max_length` | `{"max_length":120}` | 24 | 14 | 0 | 14 | 0 | 0 | 10 | 100.0% [78.5, 100.0] | 100.0% [78.5, 100.0] |
| `min_length` | `{"min_length":80}` | 24 | 13 | 0 | 13 | 0 | 0 | 11 | 100.0% [77.2, 100.0] | 100.0% [77.2, 100.0] |
| `regex_match` | `{"pattern":"^Ticket #[0-9]{6}\\b"}` | 24 | 14 | 0 | 14 | 0 | 0 | 10 | 100.0% [78.5, 100.0] | 100.0% [78.5, 100.0] |
| `regex_no_match` | `{"pattern":"\\bTODO\\b"}` | 24 | 12 | 0 | 12 | 0 | 0 | 12 | 100.0% [75.8, 100.0] | 100.0% [75.8, 100.0] |

Human agreement: pending (founder blind label of a 140-case stratified sample, twenty per judgment family).
