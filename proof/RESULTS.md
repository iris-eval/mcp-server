# Iris built-in rules — measured on the proof corpus

Generated 2026-09-04T04:48:33.916Z at commit `4207b4a`.
Corpus version `341f03991514` (sha256 of proof/corpus/*.json). Reproduce with `npm run proof`; CI runs `npm run proof -- --check`.

The positive class is the violation: precision = of the outputs the rule failed, the share that were real violations; recall = of the real violations, the share the rule failed. Intervals: Wilson 95% for precision and recall; a seeded percentile bootstrap for F1. A skipped result (the rule declined to judge) counts as not failed and is listed under "skip". Read proof/README.md before quoting a number — the corpus is synthetic, rule-aware, and labelled by the same model that wrote it.

| Rule | Bundle | n | pos | skip | TP | FP | FN | TN | Precision (95% CI) | Recall (95% CI) | F1 (95% CI) |
|---|---|--:|--:|--:|--:|--:|--:|--:|---|---|---|
| `no_pii` | safety | 90 | 45 | 0 | 34 | 6 | 11 | 39 | 85.0% [70.9, 92.9] | 75.6% [61.3, 85.8] | 0.800 [69.6, 88.4] |
| `no_injection_patterns` | safety | 90 | 42 | 0 | 41 | 0 | 1 | 48 | 100.0% [91.4, 100.0] | 97.6% [87.7, 99.6] | 0.988 [96.0, 100.0] |
| `no_stub_output` | safety | 89 | 42 | 0 | 30 | 5 | 12 | 42 | 85.7% [70.6, 93.7] | 71.4% [56.4, 82.8] | 0.779 [66.7, 87.4] |
| `no_hallucination_markers` | safety | 90 | 46 | 0 | 34 | 0 | 12 | 44 | 100.0% [89.8, 100.0] | 73.9% [59.7, 84.4] | 0.850 [75.8, 92.1] |

> ⚠ Registry rules with no family yet (unmeasured): `min_output_length`, `non_empty_output`, `sentence_count`, `expected_coverage`, `keyword_overlap`, `topic_consistency`, `no_blocklist_words`, `cost_under_threshold`, `token_efficiency`.

## Misses, by case id

The ids the rule got wrong, so a reader can open the case and judge the miss for themselves. FP = a negative case the rule failed; FN = a positive case the rule passed or skipped.

- `no_pii` — FP: pii-008, pii-037, pii-053, pii-055, pii-062, pii-075 · FN: pii-001, pii-004, pii-027, pii-041, pii-043, pii-061, pii-067, pii-071, pii-076, pii-088, pii-089
- `no_injection_patterns` — FP: none · FN: c08
- `no_stub_output` — FP: stub-018, stub-038, stub-006, stub-075, stub-020 · FN: stub-007, stub-048, stub-022, stub-024, stub-050, stub-060, stub-035, stub-070, stub-078, stub-029, stub-056, stub-084
- `no_hallucination_markers` — FP: none · FN: hall-001, hall-003, hall-017, hall-020, hall-031, hall-040, hall-043, hall-061, hall-070, hall-071, hall-072, hall-084

Human agreement: pending (founder blind label of a 40-case stratified sample).
