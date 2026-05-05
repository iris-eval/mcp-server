/*
 * deploy_rule MCP tool — programmatically add a custom eval rule.
 *
 * Mirror of the dashboard's Make-This-A-Rule composer, but callable
 * from an agent. An agent that observes a failure pattern can deploy
 * a rule without a human in the loop.
 *
 * Writes to ~/.iris/custom-rules.json (single source of truth) and
 * appends to the audit log. Persisted rules auto-load on server boot
 * and fire on every future evaluate_output call of the matching
 * eval_type.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CustomRuleStore } from '../custom-rule-store.js';
import type { CustomRuleDefinition } from '../types/eval.js';
import { LOCAL_TENANT } from '../types/tenant.js';

const CustomRuleDefinitionSchema = z.object({
  name: z.string(),
  type: z.enum([
    'regex_match',
    'regex_no_match',
    'min_length',
    'max_length',
    'contains_keywords',
    'excludes_keywords',
    'json_schema',
    'cost_threshold',
  ]),
  config: z.record(z.unknown()),
  weight: z.number().optional(),
});

const inputSchema = {
  name: z.string().min(1).max(120).describe('Human-readable rule name (used in eval results)'),
  description: z
    .string()
    .max(500)
    .optional()
    .describe('What this rule checks for and why it matters'),
  evalType: z
    .enum(['completeness', 'relevance', 'safety', 'cost', 'custom'])
    .describe('Eval category this rule belongs to; determines when it fires'),
  severity: z
    .enum(['low', 'medium', 'high', 'critical'])
    .default('medium')
    .describe('Severity used for dashboard sort + audit alerts'),
  definition: CustomRuleDefinitionSchema.describe('Check definition (regex, length, keyword, cost, or schema)'),
  sourceMomentId: z
    .string()
    .optional()
    .describe('Optional Decision Moment ID the rule was derived from (preserves workflow-inversion provenance)'),
};

export function registerDeployRuleTool(
  server: McpServer,
  customRuleStore: CustomRuleStore,
): void {
  server.registerTool(
    'deploy_rule',
    {
      title: 'Deploy Custom Rule',
      description: [
        'Deploy a new custom evaluation rule that will fire on every future evaluate_output call of its eval category.',
        '',
        'Sibling tools — list_rules enumerates deployed rules, delete_rule removes them, evaluate_output runs them. log_trace / get_traces / delete_trace handle the trace lifecycle separately; evaluate_with_llm_judge / verify_citations run semantic scoring (not heuristic-rule-driven). deploy_rule is the WRITE path that grows the custom-rule library.',
        '',
        'Behavior. Writes a row to ~/.iris/custom-rules.json (atomic write via temp file + rename) and appends a `rule.deploy` entry to the audit log (~/.iris/audit.log). The rule activates immediately for the running process and persists across restarts. Each call mints a fresh rule_id; not idempotent (deploying twice creates two rules). Tenant-scoped in Cloud tier; OSS rules are owned by LOCAL_TENANT. Rate-limited to 20 req/min on HTTP MCP.',
        '',
        'Output shape. Returns JSON: `{ "rule": { "id": "rule-XXXX", "name", "description", "evalType", "severity", "definition", "enabled": true, "createdAt", "updatedAt", "version": 1, "sourceMomentId?" } }`. The returned rule is the canonical persisted form; save the `id` if you plan to update or delete later.',
        '',
        "Use when an agent observes a recurring failure pattern and decides to enforce it as a standing rule. The `sourceMomentId` field preserves provenance — downstream audit can trace the rule back to the moment that inspired it. Combine with evaluate_output + get_traces: 1) evaluate_output surfaces failures; 2) get_traces filters to the failure set; 3) analyze the pattern; 4) deploy_rule bakes it into the default eval path.",
        '',
        "Don't use to VALIDATE a rule before committing — deploy writes immediately. Use the dashboard's preview endpoint (POST /api/v1/rules/custom/preview) for dry-run validation against sample output. Don't use to EDIT an existing rule — this call only creates; edits require a dedicated flow (coming in v0.5). To update a rule today: delete_rule then deploy_rule with the new definition.",
        '',
        'Parameters. name is 1-120 chars (Zod-enforced min/max); appears in eval_result rule_results so make it human-readable. description is optional, max 500 chars (used in dashboard tooltips). evalType determines WHEN the rule fires (must match the eval_type your evaluate_output calls use; e.g., a "completeness" rule fires on every evaluate_output where eval_type="completeness" OR eval_type="custom"). severity affects dashboard sort + audit log signal but does NOT affect scoring (scoring uses the rule\'s weight). definition.type and definition.config must match (e.g., regex_match needs config.pattern; cost_threshold needs config.max_usd; min_length needs config.min). sourceMomentId is optional but recommended (preserves workflow-inversion provenance from Make-This-A-Rule composer). Defaults: severity="medium".',
        '',
        "Error modes. Throws 400 on invalid definition (Zod rejects — e.g., regex that fails safe-regex2 ReDoS check, or length > 1000 chars). Throws 400 on empty `name`. Throws 400 if the eval category mismatches the definition type. Returns 429 when HTTP rate limit exceeded. File-write failures (disk full, read-only fs) propagate as 500; the audit log is best-effort and does not block deploy.",
      ].join('\n'),
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      // OSS: MCP tools operate under LOCAL_TENANT. See list-rules.ts for context.
      const rule = customRuleStore.deploy(LOCAL_TENANT, {
        name: args.name,
        description: args.description,
        evalType: args.evalType,
        severity: args.severity,
        definition: args.definition as CustomRuleDefinition,
        sourceMomentId: args.sourceMomentId,
        user: 'mcp',
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ rule }),
          },
        ],
      };
    },
  );
}
