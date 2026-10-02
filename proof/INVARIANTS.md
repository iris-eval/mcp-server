# What a verdict does when evidence is taken away

Generated 2026-10-02T19:12:58.420Z for v0.19.0 (local generating commit `3b469034` — branch commits are squashed on merge, so cite the version).
Composite version `7b375542274e`, 145 labelled cases, the shipped configuration. Reproduce with `npm run proof -- --invariants`; CI runs `npm run proof -- --check --invariants`.

## Sending less, with no contract

Each row takes every case that carries a field, leaves the field out of the call, and evaluates again. "Better" is a verdict that moved from fail to not checked or to pass, or from not checked to pass.

A call that leaves a field out looks the same as a call from an agent that has no such field, so with nothing said about what a call must carry, these numbers are not zero and cannot be. They are published because they are the size of the hole: an agent that reports its own evidence can improve its verdict by reporting less.

| Left out | Cases that carry it | Failed with everything sent | Fail → pass | Fail → not checked | Not checked → pass | Can a deployment require it |
|---|--:|--:|--:|--:|--:|---|
| the tool calls left out | 127 | 72 | **39** | 1 | 0 | yes: `tool_calls` |
| an empty list of tool calls sent in their place | 127 | 72 | **39** | 1 | 0 | yes: `tool_calls` |
| every tool output left out (the calls and their errors kept) | 125 | 70 | **15** | 0 | 0 | yes: `tool_outputs` |
| every tool error left out (the calls and their outputs kept) | 6 | 6 | **4** | 0 | 0 | no: nothing in the call names what is missing |
| the last tool call left out | 102 | 55 | **13** | 0 | 0 | no: nothing in the call names what is missing |
| the input left out | 145 | 77 | **14** | 0 | 0 | yes: `input` |
| the list of available tools left out | 10 | 7 | **1** | 0 | 0 | yes: `tools_catalogue` |
| the cost left out | 109 | 52 | **0** | 0 | 0 | yes: `cost` |
| the token counts left out | 109 | 52 | **0** | 0 | 0 | yes: `tokens` |

The two rows a deployment cannot require are an agent editing its own record: dropping the error from a call that failed, or dropping a call. No rule over a self-reported trace can see either. The evidence has to come from something other than the agent (a hook, a proxy, an OpenTelemetry exporter) for those rows to close.

## Sending less, with a contract in force

Where somebody has said the field must be there, leaving it out never yields a pass. Three kinds of contract: the deployment requires the input on every evaluation (`eval.requiredEvidence`), the deployment set the threshold of a rule that reads it, or the call itself supplied what the input is compared against. **Every count in the last column must be zero**, and `tests/proof/evidence-invariants.test.ts` fails when one is not.

| Contract | Left out | Cases | Fail | Not checked | **Pass** |
|---|---|--:|--:|--:|--:|
| eval.requiredEvidence names tool_calls | the tool calls left out | 127 | 37 | 90 | **0** |
| eval.requiredEvidence names tool_calls | an empty list of tool calls sent in their place | 127 | 37 | 90 | **0** |
| eval.requiredEvidence names tool_outputs | every tool output left out (the calls and their errors kept) | 125 | 81 | 44 | **0** |
| eval.requiredEvidence names input | the input left out | 145 | 63 | 82 | **0** |
| eval.requiredEvidence names tools_catalogue | the list of available tools left out | 10 | 6 | 4 | **0** |
| eval.requiredEvidence names cost | the cost left out | 109 | 52 | 57 | **0** |
| eval.requiredEvidence names tokens | the token counts left out | 109 | 52 | 57 | **0** |
| the deployment set a cost ceiling (cost_threshold) | the cost left out | 109 | 52 | 57 | **0** |
| the deployment set a step ceiling (max_steps) | the tool calls left out | 127 | 37 | 90 | **0** |
| the deployment set a step ceiling (max_steps) | an empty list of tool calls sent in their place | 127 | 37 | 90 | **0** |
| the call supplied an expected trajectory | the tool calls left out | 127 | 37 | 90 | **0** |
| the call supplied an expected trajectory | an empty list of tool calls sent in their place | 127 | 37 | 90 | **0** |

## Adding a failure

Each row takes every case, adds one more thing wrong with it, and evaluates again. A case that did not pass must still not pass: a second problem never rescues the first. **Every count in the "rescued" column must be zero.** The last columns show what the same addition does to the cases that passed; a shipped ceiling advises and does not decide, which is why a cost over it leaves them passing.

| Added | Cases that did not pass | **Rescued** | Cases that passed | Then: fail / not checked / pass | Left out |
|---|--:|--:|--:|---|--:|
| a Social Security number appended to the output | 76 | **0** | 68 | 68 / 0 / 0 | 1 |
| a placeholder appended to the output | 76 | **0** | 68 | 13 / 0 / 55 | 1 |
| a tool call that failed, which the output does not mention, added to the trajectory | 77 | **0** | 68 | 45 / 0 / 23 | 0 |
| a cost a thousand times the shipped ceiling | 77 | **0** | 68 | 0 / 0 / 68 | 0 |

"Left out" is a case whose output is empty: text appended to it makes it an output, which takes away the failure the case had instead of adding one. What that leaves (a placeholder and nothing else) passes at the shipped configuration, because the placeholder detector's published accuracy alone does not carry the risk past the line. That is a wrong pass and not a rescue; the same kind (a placeholder answer the detector flags and the verdict passes) is among the missed blocks in [COMPOSITE.md](COMPOSITE.md).

**Violations: 0 under a contract, 0 rescued.**

## What this does not cover

- Rewriting the same content in another form (case, spacing, quotation marks, wrapping the output in JSON) is not measured here.
- The additions are two fixed strings, one fixed call and one fixed cost, not a search for an addition that rescues.
- A contract says a field is present. It does not say the field is true.
