/*
 * tooltipText — centralized explanations for dashboard metrics + badges.
 *
 * Keeping these in one place ensures the same metric reads the same way
 * everywhere it appears (e.g., "Pass rate" on /dashboard, /moments,
 * /rules all share one definition). Edit here to update everywhere.
 */

/*
 * Severity semantics — the SAME sentence the MCP tool tells agents.
 *
 * These two constants must stay byte-identical to the phrases in
 * src/tools/deploy-rule.ts's `severity` description; tests/severity-copy.test.ts
 * fails the build if they drift. Before v0.5.0 severity was purely a triage
 * label, and these tooltips said so ("failures should be reviewed within the
 * day", "should page"). v0.5.0 made high/critical a hard veto — so the badge
 * on a rule that now blocks every evaluation it loses was rendering help text
 * describing the opposite behaviour. Authoritative help that contradicts the
 * product is worse than no help.
 */
export const SEVERITY_WEIGHT_ONLY =
  'contributes to the weighted score only (plus dashboard sort + audit alerts)';
export const SEVERITY_HARD_FAIL =
  'a failing evaluation of this rule forces the overall passed=false regardless of the weighted score';

export const TT = {
  // Eval verdicts
  verdictPass:
    'The composer passed every evaluation on this trace: no gate failed, no veto fired, and the risk stayed under the loss threshold. A reported rule may still have failed — the rows say which.',
  verdictFail:
    'The composer failed every evaluation on this trace: a gate or a veto failed, or the risk crossed the loss threshold. The panel names the basis.',
  verdictPartial: 'The evaluations on this trace disagree: at least one passed and at least one failed.',
  verdictUnevaluated: 'No verdict: no evaluation was recorded, every rule skipped, or a critical rule could not judge. Unknown, not clean.',
  verdictSafetyFail:
    'A safety rule failed. This is a hard fail: passed=false regardless of the weighted score — the other rules passing does not offset it.',
  verdictVetoed:
    `A high/critical rule failed, so this evaluation is a hard fail — ${SEVERITY_HARD_FAIL}. Passing rules do not offset a veto.`,

  // Significance kinds (Decision Moments)
  sigSafetyViolation:
    'A safety rule (PII, prompt injection, blocklist, stub-output, or hallucination markers) failed. Highest priority — review before this pattern becomes load-bearing.',
  sigCostSpike: 'Trace cost is far above this agent’s own baseline — more than 3.5 robust standard deviations (MADs) over the median of its recent traces. Investigate prompt size and model tier.',
  sigRegressionAlarm: 'This agent’s own stream shifted: a rule’s fail rate crossed its CUSUM line at this evaluation, about ten points over the baseline set on the agent’s earlier evaluations. Reports, never gates.',

  // Labels on your own traffic (arc 7, D-8). Labels are written on fires, so they measure precision only.
  labelRight: 'This rule was right to fire here. Your labels on a rule’s fires build its local precision — how often its fires are right on YOUR traffic — and at twenty labels that number replaces the published one on every verdict this deployment makes.',
  labelWrong: 'This rule was wrong to fire here — a false positive on your traffic. Counted into the rule’s local precision; at twenty labels the rule’s fires carry your number instead of the published one.',
  localPrecision: 'Right ÷ (right + wrong) over your labels on this rule’s fires, with a 95% Wilson interval. It measures precision only: nothing here says what a quiet rule missed, so the surface never says “local accuracy”.',
  localInForce: 'Twenty or more labels: on this deployment the rule’s fires carry this precision instead of the published positive predictive value, in the risk estimate and on every row.',
  estimatedPrior: 'The prior that an output is bad, estimated from your own labels: a rule that fires on a fraction f of your traffic with local precision p sees f·p true fires, and f·p ≈ prior × sensitivity, so prior ≈ f·p ÷ sensitivity. Your eval.prior, when set, always wins.',
  samplingSuggestion: 'Which rule’s next label narrows the most uncertainty on your traffic: the fire rate times how much one more label would shrink the interval. A suggestion, never a requirement.',
  reevaluate: 'Score this trace again under the rules, thresholds and labels as they stand now. The earlier evaluation is kept and the new one names it, so the change between them is the finding.',
  issues: 'Fires grouped by rule and by what the rule found — the same pattern, the same tool, the same measured stat — so ten fires of one pattern read as one issue with a count.',
  sigRuleCollision: 'Failures span multiple eval categories — output failed in more than one dimension.',
  sigNormalFail: 'A rule failed; the failure does not elevate to a higher significance category.',
  sigNormalPass: 'All fired rules passed — operational data, not a moment requiring review.',
  sigUnevaluated: 'No verdict: nothing was judged. No evaluation was recorded, every rule skipped, or a critical rule could not judge — unknown, not clean.',
  sigFirstFailure: 'First time this rule has failed for this agent recently.',
  sigNovelPattern: 'Failure-rule combination has not been seen for this agent before.',

  // Dashboard stats
  passRate: 'Share of evaluations the composer passed: no gate failed, no veto fired, the risk stayed under the loss threshold.',
  avgScore: 'Weighted average eval score across this period (0–1). A quality gradient only; the composer never consults it.',
  totalEvals: 'Number of distinct evaluations recorded — one per evaluate_output call.',
  agentsMonitored: 'Distinct agents that have logged at least one trace this period.',
  totalCost: 'Sum of trace-level USD cost for this period.',
  costPerTrace: 'Cost in USD attributed to this single trace by the agent (token usage × model pricing).',
  latencyMs: 'End-to-end latency the agent reported for this trace.',
  verbosityRatio: 'Output-to-input token ratio. High values may indicate verbose padding.',

  // Rule library
  ruleSeverityLow: `Low — informational: ${SEVERITY_WEIGHT_ONLY}. Does not block an evaluation.`,
  ruleSeverityMedium: `Medium — informational: ${SEVERITY_WEIGHT_ONLY}. Does not block an evaluation.`,
  ruleSeverityHigh: `High — HARD-FAIL: ${SEVERITY_HARD_FAIL}, and the rule is named in critical_failures.`,
  ruleSeverityCritical: `Critical — HARD-FAIL: ${SEVERITY_HARD_FAIL}, and the rule is named in critical_failures.`,

  // Source moment provenance
  sourceMoment:
    'This rule was authored from a Decision Moment via the Make-This-A-Rule composer. Click to see the originating trace.',
  ruleVersion:
    'Rule version, incremented on each edit. Versioning supports rollback and audit.',
  ruleEnabled:
    'Enabled rules fire on every evaluate_output call of their category. Disabled rules are kept for audit but do not fire.',
};
