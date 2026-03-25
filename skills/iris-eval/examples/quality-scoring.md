# Example: Quality Scoring

## Scenario
You're comparing two agent prompts to see which produces better output. Run both through Iris to get objective quality scores.

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

Call `evaluate_output` on each response with the same eval rules.

### Prompt A Result
```json
{
  "score": 0.92,
  "rules": {
    "topic_consistency": { "pass": true, "score": 1.0 },
    "response_complete": { "pass": true, "score": 0.95 },
    "expected_coverage": { "pass": true, "score": 0.85 },
    "no_hallucination_markers": { "pass": true, "score": 1.0 }
  }
}
```

### Prompt B Result
```json
{
  "score": 0.41,
  "rules": {
    "topic_consistency": { "pass": true, "score": 1.0 },
    "response_complete": { "pass": false, "score": 0.2 },
    "expected_coverage": { "pass": false, "score": 0.15 },
    "no_hallucination_markers": { "pass": true, "score": 1.0 }
  }
}
```

## Interpretation

Prompt A scores 0.92 (excellent). Prompt B scores 0.41 (below threshold) — it technically answered the question but the response is incomplete and lacks expected detail.

Deterministic scoring means you can make this comparison objectively, without LLM-as-judge subjectivity.
