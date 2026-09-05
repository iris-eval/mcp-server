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
import { describeTool, ERROR_ENVELOPE_SENTENCE } from './describe.js';
import { guarded, respond } from './respond.js';

const EvalTypeSchema = z.enum(['completeness', 'relevance', 'safety', 'cost', 'custom']);

/**
 * A rule with this name is already deployed and the caller did not ask to
 * replace it. Carries the existing rule(s) so an HTTP surface can answer
 * 409 with them beside the same message the MCP tool returns as
 * IRIS_DUPLICATE_RULE (src/tools/errors.ts maps it by name).
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

export const deployRuleOutputSchema = z.looseObject({
  rule: z.looseObject({ id: z.string(), name: z.string() }).describe('the rule as persisted: id (rule-<hex>, keep it for delete_rule), name, description, evalType, severity, definition, enabled, createdAt, updatedAt, version, sourceMomentId'),
  replaced: z.array(z.looseObject({ id: z.string() })).optional().describe('with replace: true, the earlier rule(s) of the same name that were retired'),
  warning: z.string().optional().describe('with replace: true, one sentence naming what was retired'),
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
      description: describeTool({
        summary: 'Deploy a custom rule that fires on every future evaluate_output call of its bundle — persisted, active immediately, audited.',
        does:
          'Writes the rule to ~/.iris/custom-rules.json, appends a rule.deploy audit entry and registers it with the running engine, so it fires on the very next call and survives restarts. ' +
          'eval_type says WHEN it fires (that bundle, and eval_type="all"); severity says what a failure DOES: low and medium only lower the weighted score, high and critical force passed to false and list the rule in critical_failures. ' +
          'definition.type picks the check (regex_match, regex_no_match, min_length, max_length, contains_keywords, excludes_keywords, json_schema, cost_threshold) and definition.config carries its keys (pattern; min_length; max_length; keywords; max_cost). ' +
          'Any bundle and type combine. Names are unique: a taken name is refused unless replace is true, which retires the earlier rule(s) first and reports them. Argument names are snake_case; the camelCase aliases evalType and sourceMomentId are accepted — pass one spelling of each.',
        whenNot:
          'To try a rule first: POST /api/v1/rules/custom/preview on the dashboard replays a definition against stored traces without deploying. For a one-off check on one call: the custom_rules argument of evaluate_output. To pause a rule: delete_rule with enabled: false.',
        returns: deployRuleOutputSchema,
        errors:
          'IRIS_DUPLICATE_RULE when the name is deployed and replace is false (the message names the existing id). ' +
          'IRIS_INVALID_RULE_CONFIG when the definition is rejected — a regex that fails the ReDoS check or exceeds 1000 characters, a missing config key — naming the field; nothing is deployed. ' +
          'IRIS_STORAGE_ERROR when the store cannot be written. An unknown key in definition, a name over 80 characters, a non-positive weight or both spellings of an alias are refused before the handler runs. ' +
          ERROR_ENVELOPE_SENTENCE,
        siblings: {
          list_rules: 'see what is deployed and the built-in roster',
          delete_rule: 'remove, disable or re-enable',
          evaluate_output: 'where the rule fires',
        },
      }),
      inputSchema: inputSchemaWithAliases,
      outputSchema: deployRuleOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guarded(async (args) => {
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
      // when the name is taken and replace is false; `guarded` turns that
      // into IRIS_DUPLICATE_RULE.
      const replaced = retireSameNamedRules(customRuleStore, evalEngine, LOCAL_TENANT, args.name, args.replace, 'mcp');

      // OSS: MCP tools operate under LOCAL_TENANT. See list-rules.ts for context.
      const rule = customRuleStore.deploy(LOCAL_TENANT, {
        replaces: replaced.map((r) => r.id),
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

      return respond(deployRuleOutputSchema, {
        rule,
        ...(replaced.length > 0 ? { replaced, warning: replacedRulesWarning(args.name, replaced) } : {}),
      });
    }),
  );
}
