# Capabilities — what Iris can judge, and what it cannot yet

Rendered from `capability-map.json` by `npm run llms:render`; do not edit `docs/capabilities.md` by hand. Of 60 capability cells (10 evaluation questions by 6 subjects), 17 are answered by a shipped, measured thing, 17 are answered with a stated limit, 22 are open gaps and 4 do not apply — every answered cell names the rule, tool, resource, route, proof row or judge template behind it.

Ten evaluation questions against six subjects. **has** means at least one shipped, measured thing answers the question for that subject; **partial** means something answers it with a stated limit; **gap** means nothing does yet; **n/a** means the question does not apply to the subject. Every *has* or *partial* cell names its evidence — a rule, a tool, a resource, a route, a proof row or a judge template — and each name resolves to something registered in this release (`tests/capability-map-contract.test.ts`). *needs* lists the inputs a call must carry for the cell's rules to judge; without them those rules skip and the verdict's `coverage` says so. The same map is served to agents inside `iris://capabilities` and at https://iris-eval.com/capabilities.

| Question | single output | output with input / context | trajectory (tool calls) | multi-run of one input | population / dataset / baseline | the evaluator itself |
|---|---|---|---|---|---|---|
| **is it safe** | has | has | gap | gap | partial | has |
| **is it grounded / correct** | partial | has | has | gap | gap | partial |
| **is it complete** | partial | partial | gap | gap | partial | has |
| **is it on-task** | gap | partial | gap | gap | partial | partial |
| **did it complete the task** | gap | gap | gap | gap | gap | gap |
| **did it act well (tool choice, arguments, efficiency)** | n/a | n/a | has | gap | partial | has |
| **what did it cost** | has | partial | partial | gap | partial | has |
| **is it better or worse than before** | n/a | n/a | gap | gap | partial | partial |
| **where and why does it fail** | has | has | has | gap | partial | has |
| **can this verdict be trusted** | has | has | partial | gap | gap | has |

### is it safe

- **single output** — *has*. Deterministic detectors for leaked personal data and credentials, injection-shaped output and deployment-prohibited words, each fire naming the pattern and the span; precision and recall are published per rule at https://iris-eval.com/proof, not yet per entity. Evidence: rule `no_pii`, rule `no_injection_patterns`, rule `no_blocklist_words`, tool `evaluate_output`, tool `deploy_rule`, proof `no_pii`. Needs: `output`.
- **output with input / context** — *has*. The safety detectors read the output; supplying the input changes nothing for them, so the single-output answer carries over. A keyed judge template for harm potential exists and is unmeasured. Evidence: rule `no_pii`, rule `no_injection_patterns`, template `safety`. Needs: `output`.
- **trajectory (tool calls)** — *gap*. Tool outputs are never scanned for injected directives, and no rule relates a directive in a tool result to a later action. Needs: `output`, `tool_calls`.
- **multi-run of one input** — *gap*. No grouping over repeated runs of one input exists, so nothing can say safe on nine of ten runs.
- **population / dataset / baseline** — *partial*. Per-rule failure counts over a time window are served to the dashboard, with no interval and no cohort key. Evidence: route `/api/v1/eval-stats`, tool `get_traces`, resource `iris://dashboard/summary`.
- **the evaluator itself** — *has*. The three safety detectors are measured on a labelled corpus with 95% intervals, and every fire carries its positive predictive value at the stated prior; robustness to obfuscated text is not yet measured. Evidence: proof `no_pii`, proof `no_injection_patterns`, proof `no_blocklist_words`, resource `iris://proof`.
### is it grounded / correct

- **single output** — *partial*. Without an input only two context-free fabrication signals run, and the result says so; the grounded signals need the material the agent was given. Evidence: rule `no_hallucination_markers`. Needs: `output`.
- **output with input / context** — *has*. A deterministic detector with context-grounded contradiction signals, measured with intervals; keyed judge templates for accuracy, correctness against a reference and faithfulness to sources, plus a citation verifier, cover what patterns cannot — on a key the user supplies. Evidence: rule `no_hallucination_markers`, proof `no_hallucination_markers`, tool `evaluate_with_llm_judge`, tool `verify_citations`, template `accuracy`, template `correctness`, template `faithfulness`. Needs: `output`, `input`.
- **trajectory (tool calls)** — *has*. Tool outputs are read as grounding material: a file, directory or URL the output cites that neither the ask nor anything the agent read mentions is evidence, with the span. Only locations are judged — a code identifier or a number belongs to the hallucination signals — and the rule declines rather than guesses when a read was truncated. Evidence: rule `grounded_in_reads`, rule `no_hallucination_markers`, tool `log_trace`. Needs: `output`, `input`, `tool_calls`, `tool_outputs`.
- **multi-run of one input** — *gap*. Consistency of claims across repeated runs of one input is not evaluated.
- **population / dataset / baseline** — *gap*. No cohort or baseline; only per-rule failure rates over time.
- **the evaluator itself** — *partial*. The fabrication detector is measured on its corpus; the judge templates are unmeasured until a user-supplied key runs the judge harness, and the page says pending until then. Evidence: proof `no_hallucination_markers`.
### is it complete

- **single output** — *partial*. Form is measured — length, sentence count, non-empty, and stub or placeholder markers — not whether the ask was answered. Evidence: rule `min_output_length`, rule `sentence_count`, rule `non_empty_output`, rule `no_stub_output`. Needs: `output`.
- **output with input / context** — *partial*. Coverage of an expected answer's terms is measured when one is supplied; nothing yet reads the structure of the ask to see which parts were answered. Evidence: rule `expected_coverage`. Needs: `output`, `expected`.
- **trajectory (tool calls)** — *gap*. No completeness rule reads the trajectory to see which parts of the ask were acted on. Needs: `output`, `tool_calls`.
- **multi-run of one input** — *gap*. No grouping over repeated runs.
- **population / dataset / baseline** — *partial*. Per-rule failure counts over time only. Evidence: route `/api/v1/eval-stats`.
- **the evaluator itself** — *has*. The completeness rules are measured as conformance to their stated formula, and each result says so in its uncertainty basis rather than presenting the number as a detection rate. Evidence: proof `min_output_length`, proof `sentence_count`, proof `non_empty_output`, proof `no_stub_output`.
### is it on-task

- **single output** — *gap*. Both relevance rules skip without the input; on a single output the question is unanswerable and the verdict's coverage says so. Needs: `output`, `input`.
- **output with input / context** — *partial*. Lexical: the share of the input's content terms the output carries, and continuity of topic across sentences, with a stated tokenizer and thresholds; a keyed helpfulness judge template exists and is unmeasured. Evidence: rule `keyword_overlap`, rule `topic_consistency`, template `helpfulness`. Needs: `output`, `input`.
- **trajectory (tool calls)** — *gap*. Nothing relates the trajectory to the ask, so a wrong tool for the question goes unjudged on every path. Needs: `output`, `tool_calls`.
- **multi-run of one input** — *gap*. No grouping over repeated runs.
- **population / dataset / baseline** — *partial*. Per-rule failure counts over time only. Evidence: route `/api/v1/eval-stats`.
- **the evaluator itself** — *partial*. The relevance rules are measured as conformance to their lexical formula; the proof does not yet include cases where the formula and a reader would disagree. Evidence: proof `keyword_overlap`, proof `topic_consistency`.
### did it complete the task

- **single output** — *gap*. Task completion cannot be judged from the output alone, and no rule attempts it. Needs: `output`.
- **output with input / context** — *gap*. No rule reads the structure of the ask, so an answer that addresses one part of three and drops the rest reads as complete. Needs: `output`, `input`.
- **trajectory (tool calls)** — *gap*. No rule judges whether the trajectory completed the task; the real-transcript acceptance record names this as open. Needs: `output`, `tool_calls`.
- **multi-run of one input** — *gap*. No grouping over repeated runs; completes the task seven of ten runs is not expressible.
- **population / dataset / baseline** — *gap*. No cohort or baseline.
- **the evaluator itself** — *gap*. No completion evaluator exists to measure.
### did it act well (tool choice, arguments, efficiency)

- **single output** — *n/a*. Acting well is a property of the trajectory, not of a single output.
- **output with input / context** — *n/a*. As for a single output.
- **trajectory (tool calls)** — *has*. Three deterministic trajectory rules, each measured with intervals: a failed tool call the output never acknowledges, a repeated call with the same input, and a call whose arguments the tool’s own JSON Schema rejects and the agent never retried. Argument validity needs the tools catalogue; tool CHOICE — whether a valid call was the right one — still has no deterministic evaluator. Evidence: rule `no_silent_tool_failure`, rule `no_tool_loop`, rule `valid_tool_arguments`, tool `log_trace`. Needs: `output`, `tool_calls`, `tools_catalogue`.
- **multi-run of one input** — *gap*. No grouping over repeated runs.
- **population / dataset / baseline** — *partial*. Per-rule failure counts for the two trajectory rules over time only. Evidence: route `/api/v1/eval-stats`.
- **the evaluator itself** — *has*. Both trajectory rules are measured with intervals on their corpus families, and each fire carries its positive predictive value. Evidence: proof `no_silent_tool_failure`, proof `no_tool_loop`.
### what did it cost

- **single output** — *has*. Trace cost and token usage are captured and judged by the cost bundle, and the evaluator's own spend — the judge's tokens and cost — is stored on the evaluation. Evidence: tool `log_trace`, rule `cost_under_threshold`, resource `iris://evaluations/{id}`. Needs: `cost`.
- **output with input / context** — *partial*. A cost ceiling and a token ratio are judged from the trace totals; the ratio measures verbosity, not efficiency, and says so. Evidence: rule `cost_under_threshold`, rule `verbosity_ratio`. Needs: `cost`, `tokens`.
- **trajectory (tool calls)** — *partial*. Cost is judged on the trace total; per-call latency is recorded, per-call tokens and cost are not yet. Evidence: rule `cost_under_threshold`, tool `log_trace`. Needs: `cost`.
- **multi-run of one input** — *gap*. No grouping over repeated runs, and no rule reads an agent's own cost distribution.
- **population / dataset / baseline** — *partial*. Aggregate cost over a time window is served to the dashboard; the cost-spike classifier uses a fixed threshold rather than the agent's own distribution. Evidence: route `/api/v1/eval-stats`, resource `iris://dashboard/summary`.
- **the evaluator itself** — *has*. The cost rules are measured as conformance to their formula, and the evaluator's own spend is stored per evaluation. Evidence: proof `cost_under_threshold`, proof `verbosity_ratio`.
### is it better or worse than before

- **single output** — *n/a*. Better or worse than before needs at least two things to compare.
- **output with input / context** — *n/a*. As for a single output.
- **trajectory (tool calls)** — *gap*. No comparison of trajectories across runs.
- **multi-run of one input** — *gap*. Nothing evaluates several runs of one input; the only canonicalisation of an input serves the loop detector.
- **population / dataset / baseline** — *partial*. Scores bucketed over time are served to the dashboard's drift view; no interval and no cohort key, so a change is shown, not tested. Evidence: route `/api/v1/eval-stats`.
- **the evaluator itself** — *partial*. The verdict a gate keys on is measured on a composite corpus, and a candidate composer is scored beside the shipped arithmetic with an interval on the difference and a held-out split, so a change to the composer is measured before it ships; nothing yet compares one release’s evaluator with the previous release’s on the same corpus across versions. Evidence: resource `iris://proof`.
### where and why does it fail

- **single output** — *has*. Every fired detection carries typed evidence — offsets into the raw output, never a paraphrase — and a message naming the pattern; the stored evaluation reads back the same way. Evidence: rule `no_pii`, rule `no_stub_output`, resource `iris://evaluations/{id}`. Needs: `output`.
- **output with input / context** — *has*. The grounded signals name the contradiction they found; measurements carry their value, unit and the threshold they were held to and where it came from. Evidence: rule `no_hallucination_markers`, rule `keyword_overlap`. Needs: `output`, `input`.
- **trajectory (tool calls)** — *has*. A silent tool failure names the failed call by index, why it failed and what the output claimed instead; a loop names every repeated call and the threshold. Evidence: rule `no_silent_tool_failure`, rule `no_tool_loop`, resource `iris://traces/{trace_id}`. Needs: `output`, `tool_calls`.
- **multi-run of one input** — *gap*. No grouping over repeated runs.
- **population / dataset / baseline** — *partial*. Top failures over a window are served to the dashboard; the out-of-sample check is a small set of real transcripts from one agent, reported without an interval. Evidence: route `/api/v1/eval-stats`, tool `get_traces`.
- **the evaluator itself** — *has*. Every false positive and false negative per rule is named by case id with the proof; the three critical rules are measured under seven evasion transforms inside their evidence span, with the cases each transform drops; the PII rule reports recall by entity, including the entities its definition does not cover; the judge templates stay unmeasured until a user-supplied key runs the judge harness. Evidence: resource `iris://proof`, proof `no_pii`, proof `no_injection_patterns`, proof `no_blocklist_words`.
### can this verdict be trusted

- **single output** — *has*. Every rule result carries what kind of claim it is, what it saw, where in the raw text it found it, and how wrong it tends to be; the verdict names which layer decided — a configured policy, a high-precision detector, a check that could not answer, or the combined risk against the deployment's stated loss ratio — and one definition of passed covers the deterministic rules, the judge and the citation verifier alike. Evidence: tool `evaluate_output`, tool `evaluate_with_llm_judge`, tool `verify_citations`, resource `iris://proof`. Needs: `output`.
- **output with input / context** — *has*. The verdict names which layer decided it and which rules did the deciding, coverage says which evaluation questions were judged and which input was missing for the rest, and a critical check that was asked and could not answer makes the verdict unknown rather than clean — a state a gate can fail closed on, and a setting the deployment chooses. Evidence: tool `evaluate_output`, resource `iris://capabilities`, route `/api/v1/capabilities`, tool `list_rules`. Needs: `output`, `input`.
- **trajectory (tool calls)** — *partial*. When tool calls are absent the trajectory rules skip and coverage names the question as unjudged; both rules are non-critical by default, so their skip never vetoes. Evidence: rule `no_silent_tool_failure`, rule `no_tool_loop`. Needs: `output`, `tool_calls`.
- **multi-run of one input** — *gap*. A verdict over repeats — vote, mean, variance — has no composer, and the judge has no repeat harness.
- **population / dataset / baseline** — *gap*. No population-level trust statement; intervals on pass rates appear nowhere on the dashboard.
- **the evaluator itself** — *has*. Precision, recall and intervals per rule are published and reproducible with one command, served to agents as a resource and on every rule result as its uncertainty; beside them, what a fire is worth at field prevalence, a credible interval that does not collapse at zero errors, the verdict’s own accuracy on a composite corpus, conformance of every custom rule type to its definition, and a matrix that asks thirteen trust questions of every evaluator and answers each cell from the proof files; the corpus is model-labelled until the blind human label lands, and every number says so. Evidence: resource `iris://proof`, tool `list_rules`, proof `no_pii`.
