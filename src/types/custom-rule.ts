/*
 * Deployed Custom Rule — persisted to ~/.iris/custom-rules.json.
 *
 * Distinct from `CustomRuleDefinition` (which is the per-evaluate-call
 * shape). A DeployedCustomRule wraps a definition with metadata: id,
 * provenance (source moment), version, enabled toggle, timestamps. Loaded
 * at startup and registered with the eval engine so it auto-fires on
 * every evaluate_output call of the matching eval_type.
 *
 * Workflow inversion (the system-design move): rules are born from
 * observed Decision Moments, not authored in isolation. The composer in
 * MomentDetailPage prefills from the source moment; the rule's
 * `sourceMomentId` keeps the provenance for audit + later analysis.
 */
import type { CustomRuleDefinition, EvalType } from './eval.js';

export type RuleSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface DeployedCustomRule {
  /** Stable id (e.g., "rule-<8-char-hex>"). Generated server-side on deploy. */
  id: string;
  /** User-readable name. Becomes the rule name in eval results. */
  name: string;
  /** Human-readable description (what the rule checks for, why it matters). */
  description: string;
  /** Eval category this rule belongs to. Determines when it fires. */
  evalType: EvalType;
  /** Severity used to sort rules in the dashboard + audit alerts. */
  severity: RuleSeverity;
  /** The check definition (regex pattern, length threshold, etc.). */
  definition: CustomRuleDefinition;
  /** Whether this rule is currently active. Disabled rules don't fire but are kept for audit. */
  enabled: boolean;
  /** ISO timestamp of deploy. */
  createdAt: string;
  /** ISO timestamp of most recent edit. */
  updatedAt: string;
  /** Optional moment ID the rule was extracted from (workflow inversion provenance). */
  sourceMomentId?: string;
  /** Version counter — incremented on edit. Starts at 1. */
  version: number;
}

export interface CustomRulesFile {
  /** File schema version — bump when shape changes. */
  version: 1;
  rules: DeployedCustomRule[];
}

export interface AuditLogEntry {
  ts: string;
  /**
   * Which tenant the action belongs to. OSS installs always emit 'local'.
   * Cloud installs emit the tenant resolved from the authenticated session.
   *
   * Optional for backward compatibility: entries written before v0.4.0
   * don't have this field. Readers MUST treat missing `tenantId` as
   * 'local' so old audit logs remain queryable on upgrade.
   */
  tenantId?: string;
  /** Action taken — currently rule.deploy / rule.delete / rule.toggle. */
  action: 'rule.deploy' | 'rule.delete' | 'rule.toggle' | 'rule.update';
  /** Who initiated. v0.4 is single-user local — always "local". v0.5+ adds users. */
  user: string;
  ruleId: string;
  ruleName?: string;
  /** Optional detail: source moment id, prior version, etc. */
  details?: Record<string, unknown>;
}

export interface RulePreviewResult {
  /** Number of historical traces evaluated. */
  tracesEvaluated: number;
  /** How many traces would have FAILED this proposed rule. */
  wouldFail: number;
  /** How many would have PASSED. */
  wouldPass: number;
  /** How many would have skipped (rule not applicable to context). */
  wouldSkip: number;
  /** First 5 example traces that would fail (with brief output preview). */
  examples: Array<{
    traceId: string;
    agentName: string;
    timestamp: string;
    outputPreview: string;
  }>;
  /** Time window covered. */
  windowSinceIso: string;
}
