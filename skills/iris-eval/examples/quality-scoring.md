# Example: Quality Scoring

## Scenario
You're comparing two agent prompts to see which produces better output. Run both through Iris to get objective quality scores.

The task both prompts were given:
```
Summarize the quarterly report's revenue results and what drove them.
```

## Prompt A Output
```
The quarterly report shows revenue increased by 15% compared to Q3.
Key drivers include the new enterprise tier and improved retention rates.
Customer acquisition cost decreased by 8% due to organic growth.
```

## Prompt B Output
```
Revenue went up.
```

## Using Iris

Call `evaluate_output` on each response with the same arguments. Two bundles matter for a quality comparison:

- `eval_type: "completeness"` — length, sentence count, and coverage of the terms you list in `expected`.
- `eval_type: "relevance"` — vocabulary overlap and topic consistency against `input` (the original ask). `input` is required for this bundle; without it both rules skip.

Request for Prompt A, completeness bundle (Prompt B is identical except for `output`):

```json
{
  "output": "The quarterly report shows revenue increased by 15% compared to Q3.\nKey drivers include the new enterprise tier and improved retention rates.\nCustomer acquisition cost decreased by 8% due to organic growth.",
  "eval_type": "completeness",
  "input": "Summarize the quarterly report's revenue results and what drove them.",
  "expected": "revenue growth, drivers, customer acquisition cost"
}
```

## Actual Results (captured 2026-09-03 against the shipped server)

### Prompt A — `completeness`
```json
{
  "id": "090778c4-9a5a-4ae3-8b99-44eed8ce40a8",
  "eval_type": "completeness",
  "score": 1,
  "passed": true,
  "rule_results": [
    { "ruleName": "min_output_length", "passed": true, "score": 1, "message": "Output length (206) meets minimum (50)" },
    { "ruleName": "non_empty_output", "passed": true, "score": 1, "message": "Output is non-empty" },
    { "ruleName": "sentence_count", "passed": true, "score": 1, "message": "Sentence count (3) meets minimum (2)" },
    { "ruleName": "expected_coverage", "passed": true, "score": 1, "message": "Covered 6/6 expected terms (100%)" }
  ],
  "suggestions": [],
  "rules_evaluated": 4,
  "rules_skipped": 0,
  "insufficient_data": false
}
```

### Prompt B — `completeness`
```json
{
  "id": "ef03775b-6852-4515-b429-57e7145d1cd0",
  "eval_type": "completeness",
  "score": 0.564,
  "passed": false,
  "rule_results": [
    { "ruleName": "min_output_length", "passed": false, "score": 0.32, "message": "Output length (16) below minimum (50)" },
    { "ruleName": "non_empty_output", "passed": true, "score": 1, "message": "Output is non-empty" },
    { "ruleName": "sentence_count", "passed": false, "score": 0.5, "message": "Sentence count (1) below minimum (2)" },
    { "ruleName": "expected_coverage", "passed": false, "score": 0.16666666666666666, "message": "Covered 1/6 expected terms (17%)" }
  ],
  "suggestions": [
    "[min_output_length] Output length (16) below minimum (50)",
    "[sentence_count] Sentence count (1) below minimum (2)",
    "[expected_coverage] Covered 1/6 expected terms (17%)"
  ],
  "rules_evaluated": 4,
  "rules_skipped": 0,
  "insufficient_data": false
}
```

### Prompt A — `relevance` (`output` + `input` only)
```json
{
  "id": "e1de6e9a-364d-431e-bfc4-ec075f12e110",
  "eval_type": "relevance",
  "score": 0.895,
  "passed": true,
  "rule_results": [
    { "ruleName": "keyword_overlap", "passed": true, "score": 1, "message": "5/10 input keywords found in output (50%)" },
    { "ruleName": "topic_consistency", "passed": true, "score": 0.7894736842105263, "message": "Topic consistency: 15.8% of output words relate to input" }
  ],
  "suggestions": [],
  "rules_evaluated": 2,
  "rules_skipped": 0,
  "insufficient_data": false
}
```

### Prompt B — `relevance`
```json
{
  "id": "738a2276-1aed-4892-8885-c879a8b5af29",
  "eval_type": "relevance",
  "score": 0.2,
  "passed": false,
  "rule_results": [
    { "ruleName": "keyword_overlap", "passed": false, "score": 0.2, "message": "1/10 input keywords found in output (10%)" },
    { "ruleName": "topic_consistency", "passed": true, "score": 1, "message": "Output too brief for meaningful topic analysis (2 words ≥ 4 chars; min 6)", "skipped": true, "skipReason": "output has < 6 words ≥ 4 chars" }
  ],
  "suggestions": [
    "[keyword_overlap] 1/10 input keywords found in output (10%)",
    "1 rule(s) skipped — excluded from the weighted score: topic_consistency (output has < 6 words ≥ 4 chars)"
  ],
  "rules_evaluated": 1,
  "rules_skipped": 1,
  "insufficient_data": false
}
```

## Interpretation

| Bundle | Prompt A (`score` / `passed`) | Prompt B (`score` / `passed`) |
|---|---|---|
| `completeness` | 1 / true | 0.564 / false |
| `relevance` | 0.895 / true | 0.2 / false |

Prompt A clears both bundles. Prompt B fails both: it is under the 50-character minimum, has one sentence where two are required, covers one of the six expected terms, and shares one of ten input keywords with the ask. `topic_consistency` skipped on Prompt B — the rule wants at least six words of four or more letters before it will judge topic — and a skipped rule is excluded from the weighted score rather than counted against it, which is why the relevance score is exactly the `keyword_overlap` score.

Deterministic scoring means you can make this comparison objectively and repeat it: the same output and arguments return the same numbers every time, with no LLM in the loop.
