# Example: Quality Scoring

## Scenario
You're comparing two agent prompts to see which produces the better answer to the same task. Run both answers through Iris and compare what comes back.

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

Call `evaluate_output` on each answer with the same arguments. Two bundles matter for a quality comparison:

- `eval_type: "completeness"` — length, sentence count, coverage of the terms you list in `expected`, and whether the answer says something. Its trajectory rules skip here, because these requests carry no tool calls.
- `eval_type: "relevance"` — how much of the ask's vocabulary and topic the answer carries, read against `input` (the original ask). `input` is required for this bundle.

Request for Prompt A, completeness bundle (Prompt B's is the same with its own `output`):

<!-- iris:quality-a-completeness-request:start -->
<!-- iris:quality-a-completeness-request:end -->

## Results

Each block below is the server's answer to the request on this page, cut to the verdict, the rules that ran, the notes and the counts. The full response also carries an `id`, each rule's evidence and measured accuracy, the risk estimate, and a row for every rule that skipped, with its reason. The blocks are written by `npm run skill-examples:render` from the server in this repository and checked on every change, so they are what the current version answers.

### Prompt A — `completeness`

<!-- iris:quality-a-completeness-response:start -->
<!-- iris:quality-a-completeness-response:end -->

### Prompt B — `completeness`

<!-- iris:quality-b-completeness-response:start -->
<!-- iris:quality-b-completeness-response:end -->

### Prompt A — `relevance`

The request carries `output` and `input` only:

<!-- iris:quality-a-relevance-request:start -->
<!-- iris:quality-a-relevance-request:end -->

<!-- iris:quality-a-relevance-response:start -->
<!-- iris:quality-a-relevance-response:end -->

### Prompt B — `relevance`

<!-- iris:quality-b-relevance-response:start -->
<!-- iris:quality-b-relevance-response:end -->

## Reading the comparison

Compare the two prompts on `score` and on the rows that failed.

- **`score`** is the quality gradient, and it separates the prompts in both bundles: Prompt A scores higher on completeness and on relevance.
- **The rows that failed** say why. On completeness, Prompt B is under the minimum length, has one sentence where two are asked for, and covers one of the six expected terms. On relevance, `keyword_overlap` and `answers_the_ask` fail, and `topic_consistency` skipped because the answer is too brief for it to read.

**`passed` is `true` for both prompts, and it is not a quality score.** `passed` is the ship verdict. It fails on what Iris will stand behind as a failure: a critical rule, a limit you set, or enough measured risk. A short answer is none of those until you say it is. Each row's `role` tells you which part it played. The three completeness rules that failed on Prompt B are measurements, which report a number and decide no verdict, so their role reads `advisory`. `interpretations` says the same of each in a sentence and names the setting that changes it. `answers_the_ask` advises for a reason of its own, given in its note: without a judge model it compares words, and comparing words fails some correct paraphrases.

## Making a floor decide

If an answer that misses your expected terms should not ship, name the rule in `eval.criticalRules` in `~/.iris/config.json` and restart the server:

<!-- iris:quality-config:start -->
<!-- iris:quality-config:end -->

The same request for Prompt B then fails the verdict:

<!-- iris:quality-b-gated-response:start -->
<!-- iris:quality-b-gated-response:end -->

The score is the same as before; the verdict changed, and `critical_failures` names the rule. Prompt A still passes under the same setting.

## Why This Matters

Deterministic scoring means the comparison repeats: the same output and arguments return the same numbers every time, with no LLM in the loop. Use `score` to choose between prompts, and `passed` to decide what ships.
