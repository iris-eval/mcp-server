# Example: Quality Scoring

## Scenario
You're comparing two agent prompts to see which produces the better answer to the same task. Run both answers through Iris and compare what comes back.

The task both prompts were given:
<!-- iris:quality-task:start -->
```
Summarize the quarterly report's revenue results and what drove them.
```
<!-- iris:quality-task:end -->

## Prompt A Output
<!-- iris:quality-prompt-a:start -->
```
The quarterly report shows revenue increased by 15% compared to Q3.
Key drivers include the new enterprise tier and improved retention rates.
Customer acquisition cost decreased by 8% due to organic growth.
```
<!-- iris:quality-prompt-a:end -->

## Prompt B Output
<!-- iris:quality-prompt-b:start -->
```
Revenue went up.
```
<!-- iris:quality-prompt-b:end -->

## Using Iris

Call `evaluate_output` on each answer with the same arguments. Two bundles matter for a quality comparison:

- `eval_type: "completeness"` — length, sentence count, coverage of the terms you list in `expected`, and whether the answer says something. Its trajectory rules skip here, because these requests carry no tool calls.
- `eval_type: "relevance"` — how much of the ask's vocabulary and topic the answer carries, read against `input` (the original ask). `input` is required for this bundle.

Request for Prompt A, completeness bundle (Prompt B's is the same with its own `output`):

<!-- iris:quality-a-completeness-request:start -->
```json
{
  "output": "The quarterly report shows revenue increased by 15% compared to Q3.\nKey drivers include the new enterprise tier and improved retention rates.\nCustomer acquisition cost decreased by 8% due to organic growth.",
  "eval_type": "completeness",
  "input": "Summarize the quarterly report's revenue results and what drove them.",
  "expected": "revenue growth, drivers, customer acquisition cost"
}
```
<!-- iris:quality-a-completeness-request:end -->

## Results

Each block below is the server's answer to the request on this page, cut to the verdict, the rules that ran, the notes and the counts. The blocks are written by `npm run skill-examples:render` from the server in this repository and checked on every change, so they are what that server answers.

### Prompt A — `completeness`

<!-- iris:quality-a-completeness-response:start -->
```json
{
  "eval_type": "completeness",
  "score": 1,
  "passed": true,
  "verdict": {
    "state": "pass",
    "basis": "clean",
    "by": []
  },
  "rule_results": [
    {
      "ruleName": "min_output_length",
      "passed": true,
      "score": 1,
      "role": "advisory",
      "message": "Output length (206) meets minimum (50)"
    },
    {
      "ruleName": "non_empty_output",
      "passed": true,
      "score": 1,
      "role": "gate",
      "message": "Output is non-empty"
    },
    {
      "ruleName": "sentence_count",
      "passed": true,
      "score": 1,
      "role": "advisory",
      "message": "Sentence count (3) meets minimum (2)"
    },
    {
      "ruleName": "expected_coverage",
      "passed": true,
      "score": 1,
      "role": "advisory",
      "message": "Covered 6/6 expected terms (100%)"
    },
    {
      "ruleName": "says_something",
      "passed": true,
      "score": 1,
      "role": "risk",
      "message": "The output says something: it is not a promise or a bare claim of completion in place of something asked to be written, an announcement with nothing after it, a placeholder, the ask handed back, or one passage on repeat"
    }
  ],
  "interpretations": [
    {
      "text": "task_completed was not judged — not supplied: the input asks for one thing — this rule judges whether a MULTI-part ask was answered in every part. Supply it to have this question judged."
    },
    {
      "text": "tool_use_correct was not judged — not supplied: context.toolCalls not provided — no trajectory to judge (pass tool_calls, or a trace_id whose trace has them). Supply it to have this question judged."
    },
    {
      "text": "Risk estimate not yet confirmed by labelled data at this level; see iris-eval.com/proof. Only 3 labelled verdicts, from 1 distinct detector pattern, had a risk estimate of 0.4–0.5: too few to test the estimate there (at least 10 verdicts from 4 patterns)."
    }
  ],
  "rules_evaluated": 5,
  "rules_skipped": 5
}
```
<!-- iris:quality-a-completeness-response:end -->

### Prompt B — `completeness`

<!-- iris:quality-b-completeness-response:start -->
```json
{
  "eval_type": "completeness",
  "score": 0.689,
  "passed": true,
  "verdict": {
    "state": "pass",
    "basis": "clean",
    "by": []
  },
  "rule_results": [
    {
      "ruleName": "min_output_length",
      "passed": false,
      "score": 0.32,
      "role": "advisory",
      "message": "Output length (16) below minimum (50)"
    },
    {
      "ruleName": "non_empty_output",
      "passed": true,
      "score": 1,
      "role": "gate",
      "message": "Output is non-empty"
    },
    {
      "ruleName": "sentence_count",
      "passed": false,
      "score": 0.5,
      "role": "advisory",
      "message": "Sentence count (1) below minimum (2)"
    },
    {
      "ruleName": "expected_coverage",
      "passed": false,
      "score": 0.16666666666666666,
      "role": "advisory",
      "message": "Covered 1/6 expected terms (17%)"
    },
    {
      "ruleName": "says_something",
      "passed": true,
      "score": 1,
      "role": "risk",
      "message": "The output says something: it is not a promise or a bare claim of completion in place of something asked to be written, an announcement with nothing after it, a placeholder, the ask handed back, or one passage on repeat"
    }
  ],
  "interpretations": [
    {
      "text": "task_completed was not judged — not supplied: the input asks for one thing — this rule judges whether a MULTI-part ask was answered in every part. Supply it to have this question judged."
    },
    {
      "text": "tool_use_correct was not judged — not supplied: context.toolCalls not provided — no trajectory to judge (pass tool_calls, or a trace_id whose trace has them). Supply it to have this question judged."
    },
    {
      "rule": "min_output_length",
      "text": "min_output_length failed and took no part in this verdict: it is a measurement, which reports a number and decides no verdict. Name it in eval.criticalRules to have its failure fail the verdict.",
      "configKey": "eval.criticalRules"
    },
    {
      "rule": "sentence_count",
      "text": "sentence_count failed and took no part in this verdict: it is a measurement, which reports a number and decides no verdict. Name it in eval.criticalRules to have its failure fail the verdict.",
      "configKey": "eval.criticalRules"
    },
    {
      "rule": "expected_coverage",
      "text": "expected_coverage failed and took no part in this verdict: it is a measurement, which reports a number and decides no verdict. Name it in eval.criticalRules to have its failure fail the verdict.",
      "configKey": "eval.criticalRules"
    },
    {
      "text": "Risk estimate not yet confirmed by labelled data at this level; see iris-eval.com/proof. Only 3 labelled verdicts, from 1 distinct detector pattern, had a risk estimate of 0.4–0.5: too few to test the estimate there (at least 10 verdicts from 4 patterns)."
    }
  ],
  "rules_evaluated": 5,
  "rules_skipped": 5
}
```
<!-- iris:quality-b-completeness-response:end -->

### Prompt A — `relevance`

The request carries no `expected` this time:

<!-- iris:quality-a-relevance-request:start -->
```json
{
  "output": "The quarterly report shows revenue increased by 15% compared to Q3.\nKey drivers include the new enterprise tier and improved retention rates.\nCustomer acquisition cost decreased by 8% due to organic growth.",
  "eval_type": "relevance",
  "input": "Summarize the quarterly report's revenue results and what drove them."
}
```
<!-- iris:quality-a-relevance-request:end -->

<!-- iris:quality-a-relevance-response:start -->
```json
{
  "eval_type": "relevance",
  "score": 0.833,
  "passed": true,
  "verdict": {
    "state": "pass",
    "basis": "clean",
    "by": []
  },
  "rule_results": [
    {
      "ruleName": "keyword_overlap",
      "passed": true,
      "score": 1,
      "role": "advisory",
      "message": "3/5 input keywords found in output (60%)"
    },
    {
      "ruleName": "topic_consistency",
      "passed": true,
      "score": 0.5,
      "role": "advisory",
      "message": "Topic consistency: 1/3 content sentences connect to the input's topic (33%)"
    },
    {
      "ruleName": "answers_the_ask",
      "passed": true,
      "score": 1,
      "role": "advisory",
      "message": "60% of the ask's terms appear in the output and 33% of its sentences connect to it; at least one measurement passes"
    }
  ],
  "rules_evaluated": 3,
  "rules_skipped": 1
}
```
<!-- iris:quality-a-relevance-response:end -->

### Prompt B — `relevance`

<!-- iris:quality-b-relevance-response:start -->
```json
{
  "eval_type": "relevance",
  "score": 0.2,
  "passed": true,
  "verdict": {
    "state": "pass",
    "basis": "clean",
    "by": []
  },
  "rule_results": [
    {
      "ruleName": "keyword_overlap",
      "passed": false,
      "score": 0.4,
      "role": "advisory",
      "message": "1/5 input keywords found in output (20%)"
    },
    {
      "ruleName": "answers_the_ask",
      "passed": false,
      "score": 0,
      "role": "advisory",
      "message": "The output hands the ask back instead of answering it"
    }
  ],
  "interpretations": [
    {
      "rule": "keyword_overlap",
      "text": "keyword_overlap failed and took no part in this verdict: it is a measurement, which reports a number and decides no verdict. Name it in eval.criticalRules to have its failure fail the verdict.",
      "configKey": "eval.criticalRules"
    },
    {
      "rule": "answers_the_ask",
      "text": "answers_the_ask failed on its lexical reading, against thresholds Iris ships rather than ones you set, so it did not decide this verdict: comparing words fails some correct paraphrases, so without a judge the rule only advises. Set IRIS_RELEVANCE_JUDGE_MODEL to a priced model (with its provider's key) to have an LLM judge decide off-topic answers, or set a keyword_overlap or topic_consistency threshold to gate on the lexical reading.",
      "configKey": "IRIS_RELEVANCE_JUDGE_MODEL"
    }
  ],
  "rules_evaluated": 2,
  "rules_skipped": 2
}
```
<!-- iris:quality-b-relevance-response:end -->

## Reading the comparison

Compare the two prompts on `score` and on the rows that failed.

- **`score`** is the quality gradient, and it separates the prompts in both bundles: Prompt A scores higher on completeness and on relevance.
- **The rows that failed** say why. On completeness, Prompt B is under the minimum length, has one sentence where two are asked for, and covers one of the six expected terms. On relevance, `keyword_overlap` and `answers_the_ask` fail, and `topic_consistency` skipped because the answer is too brief for it to read.

**`passed` is `true` for both prompts, and it is not a quality score.** `passed` is the ship verdict. It fails on what Iris will stand behind as a failure: a critical rule, a limit you set, or enough measured risk. A short answer is none of those until you say it is. Each row's `role` tells you which part it played. The three completeness rules that failed on Prompt B are measurements, which report a number and decide no verdict, so their role reads `advisory`. `interpretations` says the same of each in a sentence and names the setting that changes it. `answers_the_ask` advises for a reason of its own, given in its note: without a judge model it compares words, and comparing words fails some correct paraphrases.

## Making a floor decide

If an answer that misses your expected terms should not ship, name the rule in `eval.criticalRules` in `~/.iris/config.json` and restart the server:

<!-- iris:quality-config:start -->
```json
{
  "eval": {
    "criticalRules": [
      "expected_coverage"
    ]
  }
}
```
<!-- iris:quality-config:end -->

The same request for Prompt B then fails the verdict:

<!-- iris:quality-b-gated-response:start -->
```json
{
  "eval_type": "completeness",
  "score": 0.689,
  "passed": false,
  "verdict": {
    "state": "fail",
    "basis": "detector_veto",
    "by": [
      "expected_coverage"
    ]
  },
  "critical_failures": [
    "expected_coverage"
  ],
  "rule_results": [
    {
      "ruleName": "min_output_length",
      "passed": false,
      "score": 0.32,
      "role": "advisory",
      "message": "Output length (16) below minimum (50)"
    },
    {
      "ruleName": "non_empty_output",
      "passed": true,
      "score": 1,
      "role": "gate",
      "message": "Output is non-empty"
    },
    {
      "ruleName": "sentence_count",
      "passed": false,
      "score": 0.5,
      "role": "advisory",
      "message": "Sentence count (1) below minimum (2)"
    },
    {
      "ruleName": "expected_coverage",
      "passed": false,
      "score": 0.16666666666666666,
      "role": "veto",
      "message": "Covered 1/6 expected terms (17%)"
    },
    {
      "ruleName": "says_something",
      "passed": true,
      "score": 1,
      "role": "risk",
      "message": "The output says something: it is not a promise or a bare claim of completion in place of something asked to be written, an announcement with nothing after it, a placeholder, the ask handed back, or one passage on repeat"
    }
  ],
  "interpretations": [
    {
      "text": "task_completed was not judged — not supplied: the input asks for one thing — this rule judges whether a MULTI-part ask was answered in every part. Supply it to have this question judged."
    },
    {
      "text": "tool_use_correct was not judged — not supplied: context.toolCalls not provided — no trajectory to judge (pass tool_calls, or a trace_id whose trace has them). Supply it to have this question judged."
    }
  ],
  "rules_evaluated": 5,
  "rules_skipped": 5
}
```
<!-- iris:quality-b-gated-response:end -->

The score is the same as before; the verdict changed, and `critical_failures` names the rule. Prompt A still passes under the same setting.

## Why This Matters

Deterministic scoring means the comparison repeats: the same output and arguments return the same numbers every time, with no LLM in the loop. Use `score` to choose between prompts, and `passed` to decide what ships.
