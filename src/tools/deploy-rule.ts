/*
 * deploy_rule MCP tool — programmatically add a custom eval rule.
 *
 * Mirror of the dashboard's Make-This-A-Rule composer, but callable
 * from an agent. An agent that observes a failure pattern can deploy
 * a rule without a human in the loop.
 *
 * Writes to ~/.iris/custom-rules.json (single source of truth) and
 * appends to the audit log. Persisted rules auto-load on server boot
 * and fire on every future evaluate_output call whose eval_type equals
 * the rule's evalType (or eval_type="all").
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CustomRuleStore } from '../custom-rule-store.js';
import type { EvalEngine } from '../eval/engine.js';
import { createCustomRule } from '../eval/rules/custom.js';
import type { DeployedCustomRule } from '../types/custom-rule.js';
import type { CustomRuleDefinition, EvalType } from '../types/eval.js';
import { LOCAL_TENANT, type TenantId } from '../types/tenant.js';
import { strictInput, strictNested } from './strict-input.js';

const EvalTypeSchema = z.enum(['completeness', 'relevance', 'safety', 'cost', 'custom']);

/**
 * A rule with this name is already deployed and the caller did not ask to
 * replace it. Carries the existing rule(s) so an HTTP surface can answer
 * 409 with them beside the same message the MCP tool throws.
 */
export class DuplicateRuleNameError extends Error {
  readonly existing: DeployedCustomRule[];

  constructor(name: string, existing: DeployedCustomRule[]) {
    const listed = existing
      .map((r) => `${r.id} (eval_type ${r.evalType}, severity ${r.severity}, ${r.enabled ? 'enabled' : 'disabled'})`)
      .join('; ');
    super(
      `A rule named "${name}" is already deployed: ${listed}. Deploying a second rule with the same name ` +
        'would make both fire with indistinguishable rule_results. Pass replace: true to delete the existing rule ' +
        'and deploy this one in its place, call delete_rule first, or choose a different name. Nothing was deployed.',
    );
    this.name = 'DuplicateRuleNameError';
    this.existing = existing;
  }
}

/** One rule retired by a `replace: true` deploy. */
export interface ReplacedRule {
  id: string;
  evalType: string;
  severity: string;
}

/**
 * Same-name redeploy (#373). Two rules with one name both fire, and their
 * rule_results used to be indistinguishable — the same ruleName showing
 * PASS and FAIL in one response. Refuse by default; with replace:true,
 * retire the earlier rule(s) first so the name means one thing again. The
 * store keeps the audit trail either way.
 *
 * One function for both deploy surfaces — the `deploy_rule` tool and the
 * dashboard's `POST /api/v1/rules/custom` — so the semantics and the
 * wording cannot drift between them. Returns the rules it retired (empty
 * when the name was free); throws DuplicateRuleNameError when the name is
 * taken and `replace` is false. Nothing is deployed by this function.
 */
export function retireSameNamedRules(
  store: CustomRuleStore,
  engine: EvalEngine,
  tenantId: TenantId,
  name: string,
  replace: boolean,
  user: string,
): ReplacedRule[] {
  const sameName = store.list(tenantId).filter((r) => r.name === name);
  if (sameName.length === 0) return [];
  if (!replace) throw new DuplicateRuleNameError(name, sameName);
  const replaced: ReplacedRule[] = [];
  for (const old of sameName) {
    if (store.delete(tenantId, old.id, user)) {
      engine.unregisterRule(old.id);
      replaced.push({ id: old.id, evalType: old.evalType, severity: old.severity });
    }
  }
  return replaced;
}

/** The `warning` both deploy surfaces attach when a replace retired rules. */
export function replacedRulesWarning(name: string, replaced: ReplacedRule[]): string {
  return (
    `Replaced ${replaced.length} previously deployed rule(s) named "${name}" ` +
    `(${replaced.map((r) => r.id).join(', ')}); they no longer fire. Their audit rows are preserved.`
  );
}

/*
 * Strict one level down, like evaluate_output's custom_rules entries
 * (#376): a misspelled `wieght` used to be dropped silently. `config`
 * stays free-form (its keys depend on `type` and are validated by the
 * store at deploy time). `name` is optional: the server always overwrites
 * it with the top-level rule name (#377), so requiring a value that is
 * then discarded only invited a mismatch.
 */
const CustomRuleDefinitionSchema = strictNested(
  {
    name: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe('Optional and IGNORED if given — the server overwrites it with the top-level `name` so the rule reports under one name everywhere'),
    type: z
      .enum([
        'regex_match',
        'regex_no_match',
        'min_length',
        'max_length',
        'contains_keywords',
        'excludes_keywords',
        'json_schema',
        'cost_threshold',
      ])
      .describe('Check type — decides which config keys are required'),
    config: z
      .record(z.string(), z.unknown())
      .describe('Check configuration; required keys depend on type (regex_match: pattern; min_length: min_length; max_length: max_length; contains_keywords/excludes_keywords: keywords; cost_threshold: max_cost; json_schema: none)'),
    weight: z.number().positive().optional().describe('Weight in the weighted score (default 1; must be > 0)'),
  },
  'definition',
);

const inputSchema = {
  // 80 mirrors the persisted store's cap (custom-rule-store.ts). The tool
  // used to allow 120, so a 100-char name passed the tool schema and then
  // surfaced the store's ZodError as a raw 500 (#332). One limit, enforced
  // at the boundary, fails cleanly as a 400.
  name: z.string().min(1).max(80).describe('Human-readable rule name (1-80 chars; used in eval results). Must be unique among deployed rules unless replace=true'),
  description: z
    .string()
    .max(500)
    .optional()
    .describe('What this rule checks for and why it matters'),
  eval_type: EvalTypeSchema.optional().describe(
    'Eval category this rule belongs to; the rule fires on evaluate_output calls whose eval_type equals it (and on eval_type="all"). Canonical snake_case spelling — pass exactly one of eval_type / evalType',
  ),
  evalType: EvalTypeSchema.optional().describe(
    'camelCase alias of eval_type, accepted for compatibility — prefer eval_type (snake_case is canonical across the tools)',
  ),
  severity: z
    .enum(['low', 'medium', 'high', 'critical'])
    .default('medium')
    .describe('What a FAILURE of this rule means. low/medium: informational — contributes to the weighted score only (plus dashboard sort + audit alerts). high/critical: hard-fail — a failing evaluation of this rule forces the overall passed=false regardless of the weighted score'),
  definition: CustomRuleDefinitionSchema.describe('Check definition (regex, length, keyword, cost, or schema). Accepts exactly type, config, weight and an optional name — an unknown key is rejected'),
  source_moment_id: z
    .string()
    .optional()
    .describe('Optional Decision Moment ID the rule was derived from (preserves workflow-inversion provenance). Canonical snake_case — pass exactly one of source_moment_id / sourceMomentId'),
  sourceMomentId: z
    .string()
    .optional()
    .describe('camelCase alias of source_moment_id, accepted for compatibility — prefer source_moment_id'),
  replace: z
    .boolean()
    .default(false)
    .describe('When a rule with this name is already deployed: false (default) rejects the call; true deletes the existing same-named rule(s) and deploys this one in their place (fresh id; audit rows preserved)'),
};

/*
 * Exactly one spelling of each aliased argument. Both spellings present
 * (even with equal values) is refused rather than reconciled — a caller
 * sending both has a bug somewhere, and silently picking one hides it.
 */
const inputSchemaWithAliases = strictInput(inputSchema).superRefine((args, ctx) => {
  if (args.eval_type === undefined && args.evalType === undefined) {
    ctx.addIssue({ code: 'custom', path: ['eval_type'], message: 'eval_type is required (evalType is the accepted camelCase alias)' });
  } else if (args.eval_type !== undefined && args.evalType !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['evalType'], message: 'pass either eval_type or evalType, not both' });
  }
  if (args.source_moment_id !== undefined && args.sourceMomentId !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['sourceMomentId'], message: 'pass either source_moment_id or sourceMomentId, not both' });
  }
});

export function registerDeployRuleTool(
  server: McpServer,
  customRuleStore: CustomRuleStore,
  evalEngine: EvalEngine,
): void {
  server.registerTool(
    'deploy_rule',
    {
      title: 'Deploy Custom Rule',
      description: [
        'Deploy a new custom evaluation rule that will fire on every future evaluate_output call of its eval category.',
        '',
        'Sibling tools — list_rules enumerates deployed rules, delete_rule removes them (or disables/re-enables them with its `enabled` argument), evaluate_output runs them. log_trace / get_traces / delete_trace handle the trace lifecycle separately; evaluate_with_llm_judge / verify_citations run semantic scoring (not heuristic-rule-driven). deploy_rule is the WRITE path that grows the custom-rule library.',
        '',
        'Behavior. Writes a row to ~/.iris/custom-rules.json (atomic write via temp file + rename) and appends a `rule.deploy` entry to the audit log (~/.iris/audit.log). The rule activates immediately for the running process and persists across restarts. Each call mints a fresh rule_id. Rule names are unique among deployed rules: deploying a name that is already deployed is REJECTED unless `replace: true`, in which case the existing same-named rule(s) are deleted (audit `rule.delete` rows written, unregistered from the live engine) and the new rule takes their place under a new id — the response lists what was replaced. Tenant-scoped in Cloud tier; OSS rules are owned by LOCAL_TENANT. Rate-limited to 20 req/min on HTTP MCP.',
        '',
        'Output shape. Returns JSON: `{ "rule": { "id": "rule-XXXX", "name", "description", "evalType", "severity", "definition", "enabled": true, "createdAt", "updatedAt", "version": 1, "sourceMomentId?" }, "replaced?": [{ "id", "evalType", "severity" }], "warning?": string }`. The returned rule is the canonical persisted form; save the `id` if you plan to disable or delete later. `replaced` and `warning` appear only when `replace: true` removed an earlier rule of the same name.',
        '',
        "Use when an agent observes a recurring failure pattern and decides to enforce it as a standing rule. The `source_moment_id` field preserves provenance — downstream audit can trace the rule back to the moment that inspired it. Combine with evaluate_output + get_traces: 1) evaluate_output surfaces failures; 2) get_traces filters to the failure set; 3) analyze the pattern; 4) deploy_rule bakes it into the default eval path.",
        '',
        "Don't use to VALIDATE a rule before committing — deploy writes immediately. Use the dashboard's preview endpoint (POST /api/v1/rules/custom/preview) to replay a definition against recent stored traces first. To UPDATE a rule: call deploy_rule with the same name and `replace: true` (the old rule is deleted, the new one gets a fresh id), or delete_rule then deploy_rule. To pause a rule without losing it: delete_rule with `enabled: false`.",
        '',
        'Parameters. Argument names are snake_case (eval_type, source_moment_id) — the camelCase spellings evalType / sourceMomentId are accepted as aliases for compatibility, but pass only one spelling of each. name is 1-80 chars (Zod-enforced min/max — the same cap the persisted store applies); appears in eval_result rule_results (alongside the rule id as `ruleId`) so make it human-readable. description is optional, max 500 chars (used in dashboard tooltips). eval_type determines WHEN the rule fires: a deployed rule runs ONLY on evaluate_output calls whose eval_type equals the rule\'s eval_type, plus eval_type="all" (which runs every bundle) — a "completeness" rule does NOT fire on eval_type="safety" or on eval_type="custom"; eval_type="custom" runs rules deployed under "custom" (and the call\'s inline custom_rules) and nothing else. severity decides what a FAILURE of the rule does: low/medium failures only lower the weighted score (and drive dashboard sort + audit alerts); high/critical failures HARD-FAIL the evaluation — the overall `passed` is forced to false regardless of the weighted score, and the rule is listed in the response\'s `critical_failures`. Severity never changes the numeric score itself (that uses the rule\'s weight). definition.type and definition.config must match (e.g., regex_match needs config.pattern; cost_threshold needs config.max_cost; min_length needs config.min_length; max_length needs config.max_length; contains_keywords/excludes_keywords need config.keywords). definition.name is optional and, if given, overwritten by the top-level name. Invalid configs are REJECTED at deploy time with the offending field named, instead of deploying and then failing every evaluation. source_moment_id is optional but recommended (preserves workflow-inversion provenance from Make-This-A-Rule composer). replace defaults to false. Defaults: severity="medium", replace=false.',
        '',
        "Error modes. Throws 400 on invalid definition (Zod rejects — e.g., regex that fails safe-regex2 ReDoS check, or length > 1000 chars), on an unknown key inside `definition` (the valid keys are listed; config keys are free-form), on empty `name` or `name` over 80 chars, on a non-positive weight, and when both spellings of an aliased argument are passed. Throws when a rule with the same name is already deployed and `replace` is not true — the message names the existing rule id so you can delete it, replace it, or pick another name. Any eval_type/definition.type combination is valid (a regex_match rule can enforce a safety policy; a max_length rule can express completeness) — there is no category/type mismatch error. Returns 429 when HTTP rate limit exceeded. File-write failures (disk full, read-only fs) propagate as 500; the audit log is best-effort and does not block deploy.",
      ].join('\n'),
      inputSchema: inputSchemaWithAliases,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      const evalType = (args.eval_type ?? args.evalType) as EvalType;
      const sourceMomentId = args.source_moment_id ?? args.sourceMomentId;

      // Server overrides the inner definition's `name` so it always matches
      // the user-facing rule name — same normalization the dashboard's
      // deploy route applies. Also keeps the tool's 80-char cap authoritative
      // (an unchecked definition.name used to reach the store and surface its
      // ZodError as a raw 500).
      const definition: CustomRuleDefinition = {
        ...(args.definition as Omit<CustomRuleDefinition, 'name'> & { name?: string }),
        name: args.name,
      };

      // Same-name redeploy (#373) — shared with the dashboard's deploy
      // route; see retireSameNamedRules above. Throws (nothing deployed)
      // when the name is taken and replace is false.
      const replaced = retireSameNamedRules(customRuleStore, evalEngine, LOCAL_TENANT, args.name, args.replace, 'mcp');

      // OSS: MCP tools operate under LOCAL_TENANT. See list-rules.ts for context.
      const rule = customRuleStore.deploy(LOCAL_TENANT, {
        name: args.name,
        description: args.description,
        evalType,
        severity: args.severity,
        definition,
        sourceMomentId,
        user: 'mcp',
      });

      // Register with the live engine so the rule fires on the very next
      // evaluate_output call — the "activates immediately for the running
      // process" this description promises. Previously only the dashboard's
      // deploy route did this; MCP deploys silently waited for a restart.
      // Registered under its rule id so delete_rule can hot-remove it.
      // Severity rides along: high/critical makes the rule hard-failing.
      evalEngine.registerRule(rule.evalType, createCustomRule(rule.definition, rule.severity), rule.id);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              rule,
              ...(replaced.length > 0
                ? { replaced, warning: replacedRulesWarning(args.name, replaced) }
                : {}),
            }),
          },
        ],
      };
    },
  );
}
