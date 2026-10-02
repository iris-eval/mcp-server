# What a verdict does when evidence is taken away

Generated 2026-10-02T21:39:09.851Z for v0.19.0 (local generating commit `dc393a94` — branch commits are squashed on merge, so cite the version).
Composite version `b0381e355160`, 145 labelled cases, the shipped configuration. Reproduce with `npm run proof -- --invariants`; CI runs `npm run proof -- --check --invariants`.

## Sending less, at the shipped configuration

Each row takes every case that carries a field, sends the call without it (the field deleted, or a blank in its place), and evaluates again. "Better" is a verdict that moved from fail to not checked or to pass, or from not checked to pass.

A call that leaves a field out looks the same as a call from an agent that has no such field, so with nothing said about what a call must carry, these numbers are not zero and cannot be. They are published because they are the size of the hole: an agent that reports its own evidence can improve its verdict by reporting less. (Two of the cases carry an expected trajectory of their own, which is a contract the call makes; that is where a "fail → not checked" in the first row comes from.)

| Left out | Cases that carry it | Failed with everything sent | Fail → pass | Fail → not checked | Not checked → pass | Can a deployment require it |
|---|--:|--:|--:|--:|--:|---|
| the tool calls left out | 127 | 72 | **39** | 1 | 0 | yes: `tool_calls` |
| an empty list of tool calls sent in their place | 127 | 72 | **39** | 0 | 0 | yes: `tool_calls` |
| every tool output left out (the calls and their errors kept) | 125 | 70 | **15** | 0 | 0 | yes: `tool_outputs` |
| every tool error left out (the calls and their outputs kept) | 6 | 6 | **4** | 0 | 0 | no: nothing in the call names what is missing |
| the last tool call left out | 102 | 55 | **13** | 0 | 0 | no: nothing in the call names what is missing |
| every tool output replaced by an empty string | 125 | 70 | **15** | 0 | 0 | yes: `tool_outputs` |
| the input left out | 145 | 77 | **14** | 0 | 0 | yes: `input` |
| the input replaced by one space | 145 | 77 | **14** | 0 | 0 | yes: `input` |
| the list of available tools left out | 10 | 7 | **1** | 0 | 0 | yes: `tools_catalogue` |
| the cost left out | 109 | 52 | **0** | 0 | 0 | yes: `cost` |
| the token counts left out | 109 | 52 | **0** | 0 | 0 | yes: `tokens` |

The two rows a deployment cannot require are an agent editing its own record: dropping the error from a call that failed, or dropping a call. No rule over a self-reported trace can see either. The evidence has to come from something other than the agent (a hook, a proxy, an OpenTelemetry exporter) for those rows to close.

## Sending less, with a contract in force

Where somebody has said the field must be there, leaving it out never yields a pass. Three kinds of contract: the deployment requires the input on every evaluation (`eval.requiredEvidence`), the deployment set the threshold of a rule that reads it, or the call itself supplied what the input is compared against. **Every count in the last column must be zero**, and `tests/proof/evidence-invariants.test.ts` fails when one is not.

| Contract | Left out | Cases | Fail | Not checked | **Pass** |
|---|---|--:|--:|--:|--:|
| eval.requiredEvidence names tool_calls | the tool calls left out | 127 | 37 | 90 | **0** |
| eval.requiredEvidence names tool_calls | an empty list of tool calls sent in their place | 127 | 39 | 88 | **0** |
| eval.requiredEvidence names tool_outputs | every tool output left out (the calls and their errors kept) | 125 | 81 | 44 | **0** |
| eval.requiredEvidence names tool_outputs | every tool output replaced by an empty string | 125 | 81 | 44 | **0** |
| eval.requiredEvidence names input | the input left out | 145 | 63 | 82 | **0** |
| eval.requiredEvidence names input | the input replaced by one space | 145 | 63 | 82 | **0** |
| eval.requiredEvidence names tools_catalogue | the list of available tools left out | 10 | 6 | 4 | **0** |
| eval.requiredEvidence names cost | the cost left out | 109 | 52 | 57 | **0** |
| eval.requiredEvidence names tokens | the token counts left out | 109 | 52 | 57 | **0** |
| the deployment set a cost ceiling (cost_threshold) | the cost left out | 109 | 52 | 57 | **0** |
| the deployment set a step ceiling (max_steps) | the tool calls left out | 127 | 37 | 90 | **0** |
| the deployment set a repeat ceiling (max_tool_repeats) | the tool calls left out | 127 | 37 | 90 | **0** |
| the deployment set the relevance thresholds (keyword_overlap, topic_consistency) | the input left out | 145 | 63 | 82 | **0** |
| the deployment set the relevance thresholds (keyword_overlap, topic_consistency) | the input replaced by one space | 145 | 63 | 82 | **0** |
| the call supplied an expected trajectory | the tool calls left out | 127 | 37 | 90 | **0** |
| the call supplied an expected trajectory | an empty list of tool calls sent in their place | 127 | 127 | 0 | **0** |

**An explicit empty list of tool calls is measured, and not held at zero**, under the contract a ceiling on the calls makes. An empty list is the caller saying no calls were made, and zero calls are within any ceiling: an honest turn that used no tool must not read "not checked" because a step ceiling is set. A caller that made calls and reports none cannot be told from one that made none. `eval.requiredEvidence` is the contract that refuses an empty list (the rows above), and it is how a deployment says it wants calls it can look at. Against an expectation of calls, an empty list is judged and fails (the last row above).

| Contract | Left out | Cases | Fail | Not checked | Pass |
|---|---|--:|--:|--:|--:|
| the deployment set a step ceiling (max_steps) | an empty list of tool calls sent in their place | 127 | 39 | 0 | 88 |
| the deployment set a repeat ceiling (max_tool_repeats) | an empty list of tool calls sent in their place | 127 | 39 | 0 | 88 |

What a contract does not reach: a rule that still runs on less. With the tool outputs left out, the rule that checks an answer against failed calls runs on the calls and their error fields and finds no failure in an output it was not sent. Requiring `tool_outputs` covers that (above); promoting the rule does not.

## Adding a failure

Each row takes every case, adds one more thing wrong with it, and evaluates again. For these four additions a case that did not pass must still not pass: **every count in the "rescued" column must be zero.** This is a statement about these four, not a law about every addition (the next table has one that does rescue). The last columns show what the same addition does to the cases that passed; a shipped ceiling advises and does not decide, which is why a cost over it leaves them passing.

| Added | Cases that did not pass | **Rescued** | Cases that passed | Then: fail / not checked / pass | Left out |
|---|--:|--:|--:|---|--:|
| a Social Security number appended to the output | 76 | **0** | 68 | 68 / 0 / 0 | 1 |
| a placeholder appended to the output | 76 | **0** | 68 | 13 / 0 / 55 | 1 |
| a tool call that failed, which the output does not mention, added to the trajectory | 77 | **0** | 68 | 45 / 0 / 23 | 0 |
| a cost a thousand times the shipped ceiling | 77 | **0** | 68 | 0 / 0 / 68 | 0 |

**Measured, and not held at zero:** an addition that does rescue cases, with the reason.

| Added | Cases that did not pass | Rescued | Why |
|---|--:|--:|---|
| a sentence of refusal appended to the output ("I cannot help with that.") | 76 | 10 | the rule that checks an answer against failed tool calls accepts any word of failure, anywhere in the answer, as owning the failure. A narrower test (the word near the failed call) was measured and not shipped: it missed honest answers that owned the failure in another sentence |

"Left out" is a case whose output is empty: text appended to it makes it an output, which takes away the failure the case had instead of adding one. What that leaves (a placeholder and nothing else) passes at the shipped configuration, because the placeholder detector's published accuracy alone does not carry the risk past the line. That is a wrong pass and not a rescue; the same kind (a placeholder answer the detector flags and the verdict passes) is among the missed blocks in [COMPOSITE.md](COMPOSITE.md).

**Violations: 0 under a contract, 0 rescued.**

## What this does not cover

- Rewriting the same content in another form (case, spacing, quotation marks, wrapping the output in JSON) is not measured here.
- The additions are fixed strings, one fixed call and one fixed cost, not a search for an addition that rescues. A long run of filler text appended to a short answer also rescues one case, by diluting the share of it that is a deferral.
- A contract is checked on the whole evaluation. A call that asks for one bundle only (`eval_type: "safety"`) is answered for that bundle: a cost ceiling is not asked of it.
- A cost of zero is a cost. A deployment with a cost ceiling cannot tell a free run from a run that reported zero.
- A contract says a field is present. It does not say the field is true.
