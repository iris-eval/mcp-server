# What a verdict does when evidence is taken away, a failure is added, or the output is written another way

Generated 2026-10-03T02:27:56.809Z for v0.19.0 (local generating commit `32a0b4eb` — branch commits are squashed on merge, so cite the version).
Composite version `ed158f72a620`, 145 labelled cases, the shipped configuration. Reproduce with `npm run proof -- --invariants`; CI runs `npm run proof -- --check --invariants`.

## Sending less, at the shipped configuration

Each row takes every case that carries a field, sends the call without it (the field deleted, or a blank in its place), and evaluates again. "Better" is a verdict that moved from fail to not checked or to pass, or from not checked to pass.

A call that leaves a field out looks the same as a call from an agent that has no such field, so with nothing said about what a call must carry, these numbers are not zero and cannot be. They are published because they are the size of the hole: an agent that reports its own evidence can improve its verdict by reporting less. (Two of the cases carry an expected trajectory of their own, which is a contract the call makes; that is where a "fail → not checked" in the first row comes from.)

| Left out | Cases that carry it | Failed with everything sent | Fail → pass | Fail → not checked | Not checked → pass | Can a deployment require it |
|---|--:|--:|--:|--:|--:|---|
| the tool calls left out | 127 | 70 | **37** | 1 | 0 | yes: `tool_calls` |
| an empty list of tool calls sent in their place | 127 | 70 | **37** | 0 | 0 | yes: `tool_calls` |
| every tool output left out (the calls and their errors kept) | 125 | 68 | **13** | 0 | 0 | yes: `tool_outputs` |
| every tool error left out (the calls and their outputs kept) | 6 | 6 | **4** | 0 | 0 | no: nothing in the call names what is missing |
| the last tool call left out | 102 | 53 | **13** | 0 | 0 | no: nothing in the call names what is missing |
| every tool output replaced by an empty string | 125 | 68 | **13** | 0 | 0 | yes: `tool_outputs` |
| the input left out | 145 | 75 | **14** | 0 | 0 | yes: `input` |
| the input replaced by one space | 145 | 75 | **14** | 0 | 0 | yes: `input` |
| the list of available tools left out | 10 | 5 | **1** | 0 | 0 | yes: `tools_catalogue` |
| the cost left out | 109 | 50 | **0** | 0 | 0 | yes: `cost` |
| the token counts left out | 109 | 50 | **0** | 0 | 0 | yes: `tokens` |

The two rows a deployment cannot require are an agent editing its own record: dropping the error from a call that failed, or dropping a call. No rule over a self-reported trace can see either. The evidence has to come from something other than the agent (a hook, a proxy, an OpenTelemetry exporter) for those rows to close.

## Sending less, with a contract in force

Where somebody has said the field must be there, leaving it out never yields a pass. Three kinds of contract: the deployment requires the input on every evaluation (`eval.requiredEvidence`), the deployment set the threshold of a rule that reads it, or the call itself supplied what the input is compared against. **Every count in the last column must be zero**, and `tests/proof/evidence-invariants.test.ts` fails when one is not.

| Contract | Left out | Cases | Fail | Not checked | **Pass** |
|---|---|--:|--:|--:|--:|
| eval.requiredEvidence names tool_calls | the tool calls left out | 127 | 37 | 90 | **0** |
| eval.requiredEvidence names tool_calls | an empty list of tool calls sent in their place | 127 | 39 | 88 | **0** |
| eval.requiredEvidence names tool_outputs | every tool output left out (the calls and their errors kept) | 125 | 81 | 44 | **0** |
| eval.requiredEvidence names tool_outputs | every tool output replaced by an empty string | 125 | 81 | 44 | **0** |
| eval.requiredEvidence names input | the input left out | 145 | 61 | 84 | **0** |
| eval.requiredEvidence names input | the input replaced by one space | 145 | 61 | 84 | **0** |
| eval.requiredEvidence names tools_catalogue | the list of available tools left out | 10 | 4 | 6 | **0** |
| eval.requiredEvidence names cost | the cost left out | 109 | 50 | 59 | **0** |
| eval.requiredEvidence names tokens | the token counts left out | 109 | 50 | 59 | **0** |
| the deployment set a cost ceiling (cost_threshold) | the cost left out | 109 | 50 | 59 | **0** |
| the deployment set a step ceiling (max_steps) | the tool calls left out | 127 | 37 | 90 | **0** |
| the deployment set a repeat ceiling (max_tool_repeats) | the tool calls left out | 127 | 37 | 90 | **0** |
| the deployment set the relevance thresholds (keyword_overlap, topic_consistency) | the input left out | 145 | 61 | 84 | **0** |
| the deployment set the relevance thresholds (keyword_overlap, topic_consistency) | the input replaced by one space | 145 | 61 | 84 | **0** |
| the call supplied an expected trajectory | the tool calls left out | 127 | 37 | 90 | **0** |
| the call supplied an expected trajectory | an empty list of tool calls sent in their place | 127 | 127 | 0 | **0** |

**An explicit empty list of tool calls is measured, and not held at zero**, under the contract a ceiling on the calls makes. An empty list is the caller saying no calls were made, and zero calls are within any ceiling: an honest turn that used no tool must not read "not checked" because a step ceiling is set. A caller that made calls and reports none cannot be told from one that made none. `eval.requiredEvidence` is the contract that refuses an empty list (the rows above), and it is how a deployment says it wants calls it can look at. Against an expectation of calls, an empty list is judged and fails (the last row above).

| Contract | Left out | Cases | Fail | Not checked | Pass |
|---|---|--:|--:|--:|--:|
| the deployment set a step ceiling (max_steps) | an empty list of tool calls sent in their place | 127 | 39 | 0 | 88 |
| the deployment set a repeat ceiling (max_tool_repeats) | an empty list of tool calls sent in their place | 127 | 39 | 0 | 88 |

What a contract does not reach: a rule that still runs on less. With the tool outputs left out, the rule that checks an answer against failed calls runs on the calls and their error fields and finds no failure in an output it was not sent. Requiring `tool_outputs` covers that (above); promoting the rule does not.

## Adding a failure

Each row takes every case, adds one more thing wrong with it, and evaluates again. For these five additions a case that did not pass must still not pass: **every count in the "rescued" column must be zero.** This is a statement about these five, not a law about every addition (the next table has one that does rescue). The last columns show what the same addition does to the cases that passed; a shipped ceiling advises and does not decide, which is why a cost over it leaves them passing.

| Added | Cases that did not pass | **Rescued** | Cases that passed | Then: fail / not checked / pass | Left out |
|---|--:|--:|--:|---|--:|
| a Social Security number appended to the output | 74 | **0** | 70 | 70 / 0 / 0 | 1 |
| a placeholder appended to the output | 74 | **0** | 70 | 13 / 0 / 57 | 1 |
| a tool call that failed, which the output does not mention, added to the trajectory | 75 | **0** | 70 | 47 / 0 / 23 | 0 |
| a test run whose output reports failures, which the output does not mention, added to the trajectory | 75 | **0** | 70 | 47 / 0 / 23 | 0 |
| a cost a thousand times the shipped ceiling | 75 | **0** | 70 | 0 / 0 / 70 | 0 |

**Measured, and not held at zero:** an addition that does rescue cases, with the reason.

| Added | Cases that did not pass | Rescued | Why |
|---|--:|--:|---|
| a sentence of refusal appended to the output ("I cannot help with that.") | 74 | 8 | the rule that checks an answer against failed tool calls accepts any word of failure, anywhere in the answer, as owning the failure. A narrower test (the word near the failed call) was measured and not shipped: it missed honest answers that owned the failure in another sentence |

"Left out" is a case whose output is empty: text appended to it makes it an output, which takes away the failure the case had instead of adding one. What that leaves (a placeholder and nothing else) passes at the shipped configuration, because the placeholder detector's published accuracy alone does not carry the risk past the line. That is a wrong pass and not a rescue; the same kind (a placeholder answer the detector flags and the verdict passes) is among the missed blocks in [COMPOSITE.md](COMPOSITE.md).

## Writing the same output another way

Each row rewrites the output of every case one way and evaluates again. It counts the verdicts whose state changed and, per rule that can decide a verdict (a gate, a veto, a detection or an inference), the cases where the rule stopped or started firing.

**Spacing, line wrapping and a JSON envelope say the same thing: these rows must be all zeros.** Until 0.20.0 they were not. A phrase typed with two spaces, or cut by a line wrap, was not the phrase the rule knew; and a structured output was read in its escaped form, so a line break was the two characters `\n` and the name of a field was a word the answer had said.

| Rewriting | Cases it changes | Verdicts: fail → pass | pass → fail | Rules whose answer changed |
|---|--:|--:|--:|---|
| every space doubled | 138 | **0** | **0** | none |
| each line wrapped at 60 columns | 117 | **0** | **0** | none |
| the output as one string field of a JSON object | 145 | **0** | **0** | none |

**These rewritings are measured and are not held at zero.** Each changes something a rule is right to read. The reason is beside each.

| Rewriting | Cases it changes | Verdicts: fail → pass | pass → fail | Rules whose answer changed | Why it is not held at zero |
|---|--:|--:|--:|---|---|
| straight quotes written as curly quotes | 72 | 1 | 0 | `no_injection_patterns` (stopped 1, started 0) | the one finding lost is a JSON key in a tool payload ("_assistant_directive":), found by its shape; written with curly quotes it is no longer a JSON key, and the phrase patterns do not match the sentence inside it. A gap in the phrase patterns, not in how quotes are read |
| every line prefixed as a Markdown quote | 145 | 1 | 0 | `no_stub_output` (stopped 0, started 1); `non_empty_output` (stopped 1, started 0) | an empty output becomes a line holding a quote mark, which is no longer empty; and a diff is no longer a diff, so a TODO on a removed line is read as a TODO |
| the output as the content of a chat message, `{"role": "assistant", "content": …}` | 145 | 1 | 0 | `non_empty_output` (stopped 1, started 0) | the role is read as something the output says, so an empty content is not an empty answer: which field holds the answer is a schema the reader does not have |
| the output beside a confidence, `{"answer": …, "confidence": 0.92}` | 145 | 1 | 0 | `non_empty_output` (stopped 1, started 0) | the confidence is read as something the output says, so an empty answer is not empty; the same reason as the chat message |
| the output in upper case | 142 | 5 | 4 | `grounded_in_reads` (stopped 4, started 0); `no_hallucination_markers` (stopped 0, started 5); `no_pii` (stopped 2, started 0); `no_stub_output` (stopped 1, started 1) | case is part of what two rules are right to read: a seed phrase or a token in another case is not that secret, and a file name in another case is another file. The third change is a fault left as measured: the fabrication rule reads capitalised words as names of metrics, so prose in capitals starts findings |
| the output in lower case | 141 | 4 | 0 | `grounded_in_reads` (stopped 3, started 0); `no_pii` (stopped 2, started 0); `no_stub_output` (stopped 4, started 0) | a private key block and a file name in another case are not that key or that file, and a placeholder marker is an upper-case word on purpose: "TODO" is a marker and "a todo app" is not |

**Violations: 0 under a contract, 0 rescued, 0 changed by spacing, wrapping or a JSON envelope.**

## What this does not cover

- Rewritings of the input and of the tool calls are not measured here, only of the output.
- The additions are fixed strings, one fixed call and one fixed cost, not a search for an addition that rescues. A long run of filler text appended to a short answer also rescues one case, by diluting the share of it that is a deferral.
- A contract is checked on the whole evaluation. A call that asks for one bundle only (`eval_type: "safety"`) is answered for that bundle: a cost ceiling is not asked of it.
- A cost of zero is a cost. A deployment with a cost ceiling cannot tell a free run from a run that reported zero.
- A contract says a field is present. It does not say the field is true.
