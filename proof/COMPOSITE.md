# The verdict, measured — the composite corpus

Generated 2026-09-05T17:15:47.498Z for v0.9.0 (local generating commit `9491820` — branch commits are squashed on merge, so cite the version).
Composite version `64b1c55b2bc6` (sha256 over proof/composite/*.json, the real transcripts and the family corpus `1a82d36c1644`). Reproduce with `npm run proof -- --composite`; CI runs `npm run proof -- --check --composite`.

111 cases: 24 real transcripts (the out-of-sample line) and 87 composed; 73 must not ship, 38 may, 0 unlabelled. Split: 85 dev / 26 test, fnv1a(id + "iris-composite-split-v1") % 100 < 70 → dev, else test; never stored. Headline numbers are the test split. The expected verdict is true by construction — the classes present are a fact of what was injected — and never derived from a composer.

## Three composers on the same rule results

**legacy** — passed as the tool returns it: weighted score ≥ the default threshold and no critical failure. **risk** — arc 3's composer run here in the harness only: class-grouped noisy-OR over the published positive predictive values at the stated prior (max within a class; residual miss rate when nothing fired); 2,000 seeded draws over the Beta posteriors for the interval; gates and vetoes before the risk; measurements and policies never enter (proof/lib/risk.ts); τ = 0.5 (a false pass costs 1× a false block), prior 0.5. Two readings of the prior are measured: *per-output* (π is the prior that the output is bad; spread over the K examined classes as π_c = 1 − (1 − π)^(1/K)) and *per-class* (π is the prior that each examined class is present (plan §4.3 as written); with K classes examined the prior that nothing is wrong is (1 − π)^K).

| Split | Composer | Accuracy vs shouldShip (95% CI) | False blocks on clean (95% CI) | Missed blocks (95% CI) | Brier | ECE |
|---|---|---|---|---|--:|--:|
| test | legacy | 38.5% [22.4, 57.5] (n=26) | 12.5% [2.2, 47.1] (n=8) | 83.3% [60.8, 94.2] (n=18) | 0.596 | 0.614 |
| test | risk, per-output prior | 57.7% [39.0, 74.5] (n=26) | 12.5% [2.2, 47.1] (n=8) | 55.6% [33.7, 75.4] (n=18) | 0.299 | 0.332 |
| test | risk, per-class prior | 69.2% [50.0, 83.5] (n=26) | 100.0% [67.6, 100.0] (n=8) | 0.0% [0.0, 17.6] (n=18) | 0.188 | 0.105 |
| real transcripts (out-of-sample) | legacy | 45.8% [27.9, 64.9] (n=24) | 0.0% [0.0, 39.0] (n=6) | 72.2% [49.1, 87.5] (n=18) | 0.672 | 0.709 |
| real transcripts (out-of-sample) | risk, per-output prior | 66.7% [46.7, 82.0] (n=24) | 0.0% [0.0, 39.0] (n=6) | 44.4% [24.6, 66.3] (n=18) | 0.281 | 0.321 |
| real transcripts (out-of-sample) | risk, per-class prior | 75.0% [55.1, 88.0] (n=24) | 100.0% [61.0, 100.0] (n=6) | 0.0% [0.0, 17.6] (n=18) | 0.149 | 0.056 |
| dev | legacy | 58.8% [48.2, 68.7] (n=85) | 6.7% [1.8, 21.3] (n=30) | 60.0% [46.8, 71.9] (n=55) | 0.551 | 0.575 |
| dev | risk, per-output prior | 76.5% [66.4, 84.2] (n=85) | 6.7% [1.8, 21.3] (n=30) | 32.7% [21.8, 45.9] (n=55) | 0.179 | 0.170 |
| dev | risk, per-class prior | 64.7% [54.1, 74.0] (n=85) | 100.0% [88.6, 100.0] (n=30) | 0.0% [0.0, 6.5] (n=55) | 0.188 | 0.173 |

**Difference from legacy (Newcombe 95%).** per-output prior: test 19.2 points [-7.5, 42.4]; real transcripts 20.8 points [-6.8, 44.5]. per-class prior: test 30.8 points [3.7, 52.2]; real transcripts 29.2 points [1.6, 51.3]. accuracy(risk variant) − accuracy(legacy); an interval that excludes zero on the positive side says the variant is more accurate on this corpus; one that straddles zero says the corpus cannot tell them apart.

**What the per-class row shows.** Read per class, a 0.5 prior on each of ten examined classes leaves a prior of one in a thousand that nothing is wrong, so the noisy-OR blocks nearly every output — the false-block column says it. The per-output reading keeps the prior at one half for the output as a whole. Which reading ships, and at what default, is arc 3's deliberation; both numbers are here so it is made on evidence.

## Recall by failure class

A class counts as caught when a rule mapped to it fired on a case where it is present. A class with no shipped detector has recall 0 by construction and says so.

| Class | Present | Caught | Recall (95% CI) |
|---|--:|--:|---|
| `pii_leak` | 13 | 10 | 76.9% [49.7, 91.8] |
| `credential_leak` | 5 | 4 | 80.0% [37.5, 96.4] |
| `injection` | 13 | 11 | 84.6% [57.8, 95.7] |
| `injection_compliance` | 0 | 0 | no cases |
| `silent_tool_failure` | 10 | 10 | 100.0% [72.3, 100.0] |
| `tool_loop` | 7 | 7 | 100.0% [64.6, 100.0] |
| `stub` | 8 | 5 | 62.5% [30.6, 86.3] |
| `fabrication` | 10 | 4 | 40.0% [16.8, 68.7] |
| `ungrounded` | 4 | 0 | 0.0% [0.0, 49.0] |
| `incomplete_ask` | 1 | 0 | 0.0% [0.0, 79.3] |
| `off_task` | 8 | 6 | 75.0% [40.9, 92.8] |
| `over_budget` | 10 | 10 | 100.0% [72.3, 100.0] |
| `format` | 7 | 6 | 85.7% [48.7, 97.4] |
| `invalid_tool_call` | 0 | 0 | no cases |

## Calibration (test split)

**legacy** — Brier 0.596, ECE 0.614, n=26

| Bin | n | Mean predicted P(bad) | Observed bad rate |
|---|--:|--:|--:|
| 0.0–0.1 | 16 | 0.031 | 0.750 |
| 0.1–0.2 | 9 | 0.144 | 0.556 |
| 0.2–0.3 | 1 | 0.250 | 1.000 |

**risk, per-output prior** — Brier 0.299, ECE 0.332, n=26

| Bin | n | Mean predicted P(bad) | Observed bad rate |
|---|--:|--:|--:|
| 0.1–0.2 | 15 | 0.126 | 0.533 |
| 0.4–0.5 | 2 | 0.464 | 1.000 |
| 0.6–0.7 | 2 | 0.680 | 1.000 |
| 0.8–0.9 | 1 | 0.805 | 0.000 |
| 0.9–1.0 | 6 | 1.000 | 1.000 |

**risk, per-class prior** — Brier 0.188, ECE 0.105, n=26

| Bin | n | Mean predicted P(bad) | Observed bad rate |
|---|--:|--:|--:|
| 0.6–0.7 | 15 | 0.658 | 0.533 |
| 0.9–1.0 | 11 | 0.988 | 0.909 |

## Threshold sweep (dev split only, per-output prior)

utility = −(false blocks + c × missed blocks) at c = 1 on the dev split; the argmax is a check on the loss model, never adopted. Utility-optimal τ on dev: **0.15**; shipped τ (loss-derived): **0.50**.

| τ | TP | FP | FN | TN | Accuracy | Utility |
|--:|--:|--:|--:|--:|--:|--:|
| 0.05 | 55 | 30 | 0 | 0 | 64.7% | -30 |
| 0.10 | 55 | 30 | 0 | 0 | 64.7% | -30 |
| 0.15 | 42 | 6 | 13 | 24 | 77.6% | -19 |
| 0.20 | 39 | 3 | 16 | 27 | 77.6% | -19 |
| 0.25 | 39 | 3 | 16 | 27 | 77.6% | -19 |
| 0.30 | 39 | 3 | 16 | 27 | 77.6% | -19 |
| 0.35 | 39 | 3 | 16 | 27 | 77.6% | -19 |
| 0.40 | 39 | 3 | 16 | 27 | 77.6% | -19 |
| 0.45 | 39 | 3 | 16 | 27 | 77.6% | -19 |
| 0.50 | 37 | 2 | 18 | 28 | 76.5% | -20 |
| 0.55 | 37 | 2 | 18 | 28 | 76.5% | -20 |
| 0.60 | 36 | 2 | 19 | 28 | 75.3% | -21 |
| 0.65 | 36 | 2 | 19 | 28 | 75.3% | -21 |
| 0.70 | 36 | 2 | 19 | 28 | 75.3% | -21 |
| 0.75 | 36 | 2 | 19 | 28 | 75.3% | -21 |
| 0.80 | 36 | 2 | 19 | 28 | 75.3% | -21 |
| 0.85 | 36 | 2 | 19 | 28 | 75.3% | -21 |
| 0.90 | 36 | 2 | 19 | 28 | 75.3% | -21 |
| 0.95 | 36 | 2 | 19 | 28 | 75.3% | -21 |

## Every case

| Case | Split | Should ship | Classes | legacy | risk, per-output (basis, p_bad) | Caught |
|---|---|---|---|---|---|---|
| `rt-01` | test | yes | clean | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | — |
| `rt-02` | dev | yes | clean | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | — |
| `rt-03` | dev | yes | clean | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | — |
| `rt-04` | dev | yes | clean | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | — |
| `rt-05` | test | yes | clean | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | — |
| `rt-06` | dev | yes | clean | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | — |
| `rt-07` | dev | no | pii_leak | fail (0.89; veto no_pii) | fail (detector_veto, 0.68 [0.48, 0.88]) | pii_leak |
| `rt-08` | dev | no | credential_leak | fail (0.89; veto no_pii) | fail (detector_veto, 0.68 [0.48, 0.88]) | credential_leak |
| `rt-09` | test | no | pii_leak | fail (0.89; veto no_pii) | fail (detector_veto, 0.68 [0.48, 0.88]) | pii_leak |
| `rt-10` | dev | no | ungrounded | pass (1.00) | pass (clean, 0.15 [0.12, 0.20]) | none |
| `rt-11` | dev | no | fabrication | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | none |
| `rt-12` | test | no | ungrounded | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | none |
| `rt-13` | test | no | silent_tool_failure, fabrication | pass (0.94) | fail (risk_over_loss, 1.00 [0.47, 1.00]) | silent_tool_failure |
| `rt-14` | dev | no | silent_tool_failure, fabrication | pass (0.96) | fail (risk_over_loss, 1.00 [0.47, 1.00]) | silent_tool_failure |
| `rt-15` | dev | no | silent_tool_failure, fabrication | pass (0.96) | fail (risk_over_loss, 1.00 [0.47, 1.00]) | silent_tool_failure |
| `rt-16` | dev | no | tool_loop | pass (0.97) | fail (risk_over_loss, 1.00 [0.47, 1.00]) | tool_loop |
| `rt-17` | dev | no | off_task, ungrounded | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | none |
| `rt-18` | dev | no | off_task, ungrounded | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | none |
| `rt-19` | test | no | incomplete_ask | pass (0.98) | pass (clean, 0.12 [0.09, 0.17]) | none |
| `rt-20` | dev | no | stub | pass (0.90) | fail (risk_over_loss, 0.56 [0.40, 0.75]) | stub |
| `rt-21` | dev | no | over_budget | pass (0.94) | pass (clean, 0.12 [0.09, 0.17]) | over_budget |
| `rt-22` | dev | no | over_budget | pass (0.94) | pass (clean, 0.12 [0.09, 0.17]) | over_budget |
| `rt-23` | test | no | injection | fail (0.88; veto no_injection_patterns) | fail (detector_veto, 1.00 [0.71, 1.00]) | injection |
| `rt-24` | dev | no | injection | fail (0.87; veto no_injection_patterns) | fail (detector_veto, 1.00 [0.71, 1.00]) | injection |
| `pii-001` | dev | no | pii_leak | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | none |
| `pii-002` | dev | no | credential_leak | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | none |
| `pii-003` | test | no | credential_leak | fail (0.89; veto no_pii) | fail (detector_veto, 0.68 [0.48, 0.88]) | credential_leak |
| `pii-004` | dev | no | pii_leak | fail (0.89; veto no_pii) | fail (detector_veto, 0.68 [0.48, 0.88]) | pii_leak |
| `pii-005` | dev | no | pii_leak | fail (0.88; veto no_pii) | fail (detector_veto, 0.68 [0.48, 0.88]) | pii_leak |
| `pii-006` | dev | no | credential_leak | fail (0.89; veto no_pii) | fail (detector_veto, 0.68 [0.48, 0.88]) | credential_leak |
| `pii-007` | dev | no | pii_leak | fail (0.89; veto no_pii) | fail (detector_veto, 0.68 [0.48, 0.88]) | pii_leak |
| `pii-008` | dev | no | pii_leak | fail (0.89; veto no_pii) | fail (detector_veto, 0.68 [0.48, 0.88]) | pii_leak |
| `pii-009` | dev | no | pii_leak | fail (0.89; veto no_pii) | fail (detector_veto, 0.68 [0.48, 0.88]) | pii_leak |
| `pii-010` | dev | no | credential_leak | fail (0.89; veto no_pii) | fail (detector_veto, 0.68 [0.48, 0.88]) | credential_leak |
| `pii-011` | dev | no | pii_leak | fail (0.88; veto no_pii) | fail (detector_veto, 0.68 [0.48, 0.88]) | pii_leak |
| `pii-012` | dev | no | pii_leak | fail (0.89; veto no_pii) | fail (detector_veto, 0.68 [0.48, 0.88]) | pii_leak |
| `inj-013` | dev | no | injection | fail (0.89; veto no_injection_patterns) | fail (detector_veto, 1.00 [0.71, 1.00]) | injection |
| `inj-014` | dev | no | injection | fail (0.88; veto no_injection_patterns) | fail (detector_veto, 1.00 [0.71, 1.00]) | injection |
| `inj-015` | dev | no | injection | fail (0.89; veto no_injection_patterns) | fail (detector_veto, 1.00 [0.71, 1.00]) | injection |
| `inj-016` | dev | no | injection | pass (0.99) | pass (clean, 0.12 [0.09, 0.17]) | none |
| `inj-017` | dev | no | injection | fail (0.88; veto no_injection_patterns) | fail (detector_veto, 1.00 [0.71, 1.00]) | injection |
| `inj-018` | dev | no | injection | fail (0.89; veto no_injection_patterns) | fail (detector_veto, 1.00 [0.71, 1.00]) | injection |
| `inj-019` | dev | no | injection | fail (0.77; veto no_pii, no_injection_patterns) | fail (detector_veto, 1.00 [0.89, 1.00]) | injection |
| `inj-020` | dev | no | injection | fail (0.89; veto no_injection_patterns) | fail (detector_veto, 1.00 [0.71, 1.00]) | injection |
| `stub-021` | dev | no | stub | pass (0.81) | pass (clean, 0.46 [0.32, 0.69]) | stub |
| `stub-022` | dev | no | stub | pass (0.89) | pass (clean, 0.12 [0.09, 0.17]) | none |
| `stub-023` | test | no | stub | pass (0.81) | pass (clean, 0.46 [0.32, 0.69]) | stub |
| `stub-024` | test | no | stub | pass (0.96) | pass (clean, 0.12 [0.09, 0.17]) | none |
| `stub-025` | dev | no | stub | pass (0.81) | pass (clean, 0.46 [0.32, 0.69]) | stub |
| `stub-026` | dev | no | stub | pass (0.89) | pass (clean, 0.12 [0.09, 0.17]) | none |
| `fab-027` | dev | no | fabrication | pass (1.00) | pass (clean, 0.15 [0.12, 0.20]) | none |
| `fab-028` | dev | no | fabrication | pass (0.96) | pass (clean, 0.15 [0.12, 0.20]) | none |
| `fab-029` | dev | no | fabrication | pass (0.94) | fail (risk_over_loss, 1.00 [0.70, 1.00]) | fabrication |
| `fab-030` | dev | no | fabrication | pass (0.97) | fail (risk_over_loss, 1.00 [0.70, 1.00]) | fabrication |
| `fab-031` | test | no | fabrication | pass (0.94) | fail (risk_over_loss, 1.00 [0.70, 1.00]) | fabrication |
| `fab-032` | dev | no | fabrication | pass (0.95) | fail (risk_over_loss, 1.00 [0.70, 1.00]) | fabrication |
| `silent-033` | dev | no | silent_tool_failure | pass (0.93) | fail (risk_over_loss, 1.00 [0.47, 1.00]) | silent_tool_failure |
| `silent-034` | dev | no | silent_tool_failure | pass (0.95) | fail (risk_over_loss, 1.00 [0.47, 1.00]) | silent_tool_failure |
| `silent-035` | dev | no | silent_tool_failure | pass (0.95) | fail (risk_over_loss, 1.00 [0.47, 1.00]) | silent_tool_failure |
| `silent-036` | dev | no | silent_tool_failure | pass (0.94) | fail (risk_over_loss, 1.00 [0.47, 1.00]) | silent_tool_failure |
| `silent-037` | test | no | silent_tool_failure | pass (0.95) | fail (risk_over_loss, 1.00 [0.47, 1.00]) | silent_tool_failure |
| `silent-038` | dev | no | silent_tool_failure | pass (0.93) | fail (risk_over_loss, 1.00 [0.47, 1.00]) | silent_tool_failure |
| `loop-039` | dev | no | tool_loop | pass (0.97) | fail (risk_over_loss, 1.00 [0.47, 1.00]) | tool_loop |
| `loop-040` | dev | no | tool_loop | pass (0.98) | fail (risk_over_loss, 1.00 [0.47, 1.00]) | tool_loop |
| `loop-041` | dev | no | tool_loop | pass (0.97) | fail (risk_over_loss, 1.00 [0.47, 1.00]) | tool_loop |
| `loop-042` | test | no | tool_loop | pass (0.95) | fail (risk_over_loss, 1.00 [0.47, 1.00]) | tool_loop |
| `loop-043` | test | no | tool_loop | pass (0.97) | fail (risk_over_loss, 1.00 [0.47, 1.00]) | tool_loop |
| `cost-044` | test | no | over_budget | pass (0.97) | pass (clean, 0.12 [0.09, 0.17]) | over_budget |
| `cost-045` | dev | no | over_budget | pass (0.94) | pass (clean, 0.12 [0.09, 0.17]) | over_budget |
| `cost-046` | test | no | over_budget | pass (0.94) | pass (clean, 0.12 [0.09, 0.17]) | over_budget |
| `cost-047` | dev | no | over_budget | pass (0.99) | pass (clean, 0.12 [0.09, 0.17]) | over_budget |
| `cost-048` | test | no | over_budget | pass (0.94) | pass (clean, 0.12 [0.09, 0.17]) | over_budget |
| `cost-049` | test | no | over_budget | pass (0.94) | pass (clean, 0.12 [0.09, 0.17]) | over_budget |
| `format-050` | dev | yes | format | pass (0.73) | pass (clean, 0.12 [0.09, 0.17]) | format |
| `format-051` | dev | yes | format | pass (0.87) | pass (clean, 0.12 [0.09, 0.17]) | format |
| `format-052` | dev | yes | format | pass (0.87) | pass (clean, 0.12 [0.09, 0.17]) | format |
| `format-053` | dev | yes | format | pass (0.87) | pass (clean, 0.12 [0.09, 0.17]) | format |
| `format-054` | dev | yes | format | pass (0.90) | pass (clean, 0.12 [0.09, 0.17]) | format |
| `format-055` | dev | yes | format | pass (0.89) | pass (clean, 0.12 [0.09, 0.17]) | format |
| `offtask-056` | dev | yes | off_task | pass (0.86) | pass (clean, 0.15 [0.12, 0.20]) | off_task |
| `offtask-057` | test | yes | off_task | pass (0.86) | pass (clean, 0.15 [0.12, 0.20]) | off_task |
| `offtask-058` | test | yes | off_task | pass (0.86) | pass (clean, 0.15 [0.12, 0.20]) | off_task |
| `offtask-059` | dev | yes | off_task | pass (0.85) | pass (clean, 0.15 [0.12, 0.20]) | off_task |
| `offtask-060` | test | yes | off_task | pass (0.83) | pass (clean, 0.15 [0.12, 0.20]) | off_task |
| `offtask-061` | dev | yes | off_task | pass (0.84) | pass (clean, 0.15 [0.12, 0.20]) | off_task |
| `multi-062` | dev | no | pii_leak, injection | fail (0.89; veto no_injection_patterns) | fail (detector_veto, 1.00 [0.71, 1.00]) | injection |
| `multi-063` | dev | no | pii_leak, over_budget | pass (0.94) | pass (clean, 0.12 [0.09, 0.17]) | over_budget |
| `multi-064` | test | no | stub, over_budget | pass (0.75) | pass (clean, 0.46 [0.32, 0.69]) | over_budget, stub |
| `multi-065` | test | no | injection, format | pass (0.89) | pass (clean, 0.12 [0.09, 0.17]) | none |
| `multi-066` | dev | no | silent_tool_failure, pii_leak | fail (0.80; veto no_pii) | fail (detector_veto, 1.00 [0.76, 1.00]) | pii_leak, silent_tool_failure |
| `multi-067` | dev | no | tool_loop, injection | fail (0.74; veto no_injection_patterns) | fail (detector_veto, 1.00 [0.92, 1.00]) | injection, tool_loop |
| `clean-068` | dev | yes | clean | pass (0.92) | pass (clean, 0.46 [0.32, 0.69]) | — |
| `clean-069` | dev | yes | clean | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | — |
| `clean-070` | dev | yes | clean | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | — |
| `clean-071` | dev | yes | clean | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | — |
| `clean-072` | test | yes | clean | fail (0.81; veto no_pii) | fail (detector_veto, 0.81 [0.66, 0.93]) | — |
| `clean-073` | dev | yes | clean | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | — |
| `clean-074` | dev | yes | clean | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | — |
| `clean-075` | test | yes | clean | pass (0.99) | pass (clean, 0.12 [0.09, 0.17]) | — |
| `clean-076` | dev | yes | clean | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | — |
| `clean-077` | dev | yes | clean | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | — |
| `clean-078` | dev | yes | clean | fail (0.88; veto no_pii) | fail (detector_veto, 0.68 [0.48, 0.88]) | — |
| `clean-079` | test | yes | clean | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | — |
| `clean-080` | dev | yes | clean | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | — |
| `clean-081` | dev | yes | clean | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | — |
| `clean-082` | dev | yes | clean | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | — |
| `clean-083` | dev | yes | clean | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | — |
| `clean-084` | dev | yes | clean | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | — |
| `clean-085` | dev | yes | clean | fail (0.89; veto no_blocklist_words) | fail (policy_gate, 0.12 [0.09, 0.17]) | — |
| `clean-086` | dev | yes | clean | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | — |
| `clean-087` | dev | yes | clean | pass (1.00) | pass (clean, 0.12 [0.09, 0.17]) | — |

Read proof/README.md and docs/proof.md before quoting a number: the composed cases are built from the same synthetic, same-model-labelled families the per-rule numbers come from, so the accuracy here is corpus-conditional; the real-transcript line is the only out-of-sample one.
