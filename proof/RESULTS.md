# Iris built-in rules — measured on the proof corpus

Generated 2026-09-05T10:06:35.369Z for v0.9.0 (local generating commit `b417a93` — branch commits are squashed on merge, so cite the version).
Corpus version `1251d242916c` (sha256 of proof/corpus/*.json). Reproduce with `npm run proof`; CI runs `npm run proof -- --check`.

The positive class is the violation: precision = of the outputs the rule failed, the share that were real violations; recall = of the real violations, the share the rule failed. Intervals: Wilson 95% for precision and recall; a seeded percentile bootstrap for F1. A skipped result (the rule declined to judge) counts as not failed and is listed under "skip". Read proof/README.md before quoting a number — the corpus is synthetic, rule-aware, and labelled by the same model that wrote it.

| Rule | Bundle | n | pos | skip | TP | FP | FN | TN | Precision (95% CI) | Recall (95% CI) | F1 (95% CI) |
|---|---|--:|--:|--:|--:|--:|--:|--:|---|---|---|
| `min_output_length` | completeness | 29 | 13 | 0 | 13 | 0 | 0 | 16 | 100.0% [77.2, 100.0] | 100.0% [77.2, 100.0] | 1.000 [100.0, 100.0] |
| `non_empty_output` | completeness | 29 | 12 | 0 | 10 | 0 | 2 | 17 | 100.0% [72.3, 100.0] | 83.3% [55.2, 95.3] | 0.909 [73.7, 100.0] |
| `sentence_count` | completeness | 30 | 14 | 0 | 8 | 0 | 6 | 16 | 100.0% [67.6, 100.0] | 57.1% [32.6, 78.6] | 0.727 [47.1, 90.9] |
| `expected_coverage` | completeness | 29 | 14 | 0 | 14 | 0 | 0 | 15 | 100.0% [78.5, 100.0] | 100.0% [78.5, 100.0] | 1.000 [100.0, 100.0] |
| `keyword_overlap` | relevance | 30 | 10 | 0 | 10 | 0 | 0 | 20 | 100.0% [72.3, 100.0] | 100.0% [72.3, 100.0] | 1.000 [100.0, 100.0] |
| `topic_consistency` | relevance | 31 | 12 | 1 | 11 | 0 | 1 | 19 | 100.0% [74.1, 100.0] | 91.7% [64.6, 98.5] | 0.957 [83.3, 100.0] |
| `no_pii` | safety | 90 | 45 | 0 | 34 | 5 | 11 | 40 | 87.2% [73.3, 94.4] | 75.6% [61.3, 85.8] | 0.809 [71.0, 89.4] |
| `no_blocklist_words` | safety | 32 | 15 | 0 | 11 | 1 | 4 | 16 | 91.7% [64.6, 98.5] | 73.3% [48.0, 89.1] | 0.815 [60.9, 95.2] |
| `no_injection_patterns` | safety | 90 | 42 | 0 | 41 | 0 | 1 | 48 | 100.0% [91.4, 100.0] | 97.6% [87.7, 99.6] | 0.988 [96.0, 100.0] |
| `no_stub_output` | safety | 89 | 42 | 0 | 30 | 5 | 12 | 42 | 85.7% [70.6, 93.7] | 71.4% [56.4, 82.8] | 0.779 [66.7, 87.4] |
| `no_hallucination_markers` | safety | 90 | 46 | 0 | 34 | 0 | 12 | 44 | 100.0% [89.8, 100.0] | 73.9% [59.7, 84.4] | 0.850 [75.8, 92.1] |
| `no_silent_tool_failure` | safety | 30 | 14 | 0 | 13 | 0 | 1 | 16 | 100.0% [77.2, 100.0] | 92.9% [68.5, 98.7] | 0.963 [86.7, 100.0] |
| `cost_under_threshold` | cost | 26 | 10 | 2 | 10 | 0 | 0 | 16 | 100.0% [72.3, 100.0] | 100.0% [72.3, 100.0] | 1.000 [100.0, 100.0] |
| `token_efficiency` | cost | 25 | 9 | 1 | 9 | 0 | 0 | 16 | 100.0% [70.1, 100.0] | 100.0% [70.1, 100.0] | 1.000 [100.0, 100.0] |
| `no_tool_loop` | cost | 28 | 12 | 0 | 12 | 0 | 0 | 16 | 100.0% [75.8, 100.0] | 100.0% [75.8, 100.0] | 1.000 [100.0, 100.0] |

## Misses, by case id

The ids the rule got wrong, so a reader can open the case and judge the miss for themselves. FP = a negative case the rule failed; FN = a positive case the rule passed or skipped.

- `min_output_length` — FP: none · FN: none
- `non_empty_output` — FP: none · FN: nonempty-009, nonempty-010
- `sentence_count` — FP: none · FN: sentences-005, sentences-006, sentences-007, sentences-008, sentences-009, sentences-014
- `expected_coverage` — FP: none · FN: none
- `keyword_overlap` — FP: none · FN: none
- `topic_consistency` — FP: none · FN: topic-021
- `no_pii` — FP: pii-008, pii-037, pii-053, pii-062, pii-075 · FN: pii-001, pii-004, pii-027, pii-041, pii-043, pii-061, pii-067, pii-071, pii-076, pii-088, pii-089
- `no_blocklist_words` — FP: blocklist-016 · FN: blocklist-010, blocklist-011, blocklist-012, blocklist-013
- `no_injection_patterns` — FP: none · FN: c08
- `no_stub_output` — FP: stub-018, stub-038, stub-006, stub-075, stub-020 · FN: stub-007, stub-048, stub-022, stub-024, stub-050, stub-060, stub-035, stub-070, stub-078, stub-029, stub-056, stub-084
- `no_hallucination_markers` — FP: none · FN: hall-001, hall-003, hall-017, hall-020, hall-031, hall-040, hall-043, hall-061, hall-070, hall-071, hall-072, hall-084
- `no_silent_tool_failure` — FP: none · FN: silent-012
- `cost_under_threshold` — FP: none · FN: none
- `token_efficiency` — FP: none · FN: none
- `no_tool_loop` — FP: none · FN: none

Human agreement: pending (founder blind label of a 40-case stratified sample).
