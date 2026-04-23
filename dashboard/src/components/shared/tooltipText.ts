/*
 * tooltipText — centralized explanations for dashboard metrics + badges.
 *
 * Keeping these in one place ensures the same metric reads the same way
 * everywhere it appears (e.g., "Pass rate" on /dashboard, /moments,
 * /rules all share one definition). Edit here to update everywhere.
 */

export const TT = {
  // Eval verdicts
  verdictPass: 'All evaluation rules that ran for this trace passed.',
  verdictFail: 'Every fired rule failed for this trace.',
  verdictPartial: 'A mix of failures and passes — some rules failed but others passed.',
  verdictUnevaluated: 'No evaluation was recorded for this trace, or every applicable rule was skipped.',

  // Significance kinds (Decision Moments)
  sigSafetyViolation:
    'A safety rule (PII, prompt injection, blocklist, or stub-output) failed. Highest priority — review before this pattern becomes load-bearing.',
  sigCostSpike: 'Trace cost crossed the per-trace cost-spike threshold. Investigate prompt size and model tier.',
  sigRuleCollision: 'Failures span multiple eval categories — output failed in more than one dimension.',
  sigNormalFail: 'A rule failed; the failure does not elevate to a higher significance category.',
  sigNormalPass: 'All fired rules passed — operational data, not a moment requiring review.',
  sigFirstFailure: 'First time this rule has failed for this agent recently.',
  sigNovelPattern: 'Failure-rule combination has not been seen for this agent before.',

  // Dashboard stats
  passRate: 'Share of evaluations whose weighted score met the configured pass threshold.',
  avgScore: 'Weighted average eval score across this period (0–1; threshold typically 0.7).',
  totalEvals: 'Number of distinct evaluations recorded — one per evaluate_output call.',
  agentsMonitored: 'Distinct agents that have logged at least one trace this period.',
  totalCost: 'Sum of trace-level USD cost for this period.',
  costPerTrace: 'Cost in USD attributed to this single trace by the agent (token usage × model pricing).',
  latencyMs: 'End-to-end latency the agent reported for this trace.',
  tokenEfficiency: 'Output-to-input token ratio. High values may indicate verbose padding.',

  // Rule library
  ruleSeverityLow: 'Informational — surface in lists but do not page on failure.',
  ruleSeverityMedium: 'Standard severity — failures are noted but not urgent.',
  ruleSeverityHigh: 'High severity — failures should be reviewed within the day.',
  ruleSeverityCritical: 'Critical — failures should page or trigger immediate response.',

  // Source moment provenance
  sourceMoment:
    'This rule was authored from a Decision Moment via the Make-This-A-Rule composer. Click to see the originating trace.',
  ruleVersion:
    'Rule version, incremented on each edit. Versioning supports rollback and audit.',
  ruleEnabled:
    'Enabled rules fire on every evaluate_output call of their category. Disabled rules are kept for audit but do not fire.',
};
