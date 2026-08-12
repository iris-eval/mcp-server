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
import type { EvalEngine } from '../eval/engine.js';
import { createCustomRule } from '../eval/rules/custom.js';
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
  config: z.record(z.string(), z.unknown()),
  weight: z.number().optional(),
});

const inputSchema = {
  // 80 mirrors the persisted store's cap (custom-rule-store.ts). The tool
  // used to allow 120, so a 100-char name passed the tool schema and then
  // surfaced the store's ZodError as a raw 500 (#332). One limit, enforced
  // at the boundary, fails cleanly as a 400.
  name: z.string().min(1).max(80).describe('Human-readable rule name (1-80 chars; used in eval results)'),
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
    .describe('What a FAILURE of this rule means. low/medium: informational — contributes to the weighted score only (plus dashboard sort + audit alerts). high/critical: hard-fail — a failing evaluation of this rule forces the overall passed=false regardless of the weighted score'),
  definition: CustomRuleDefinitionSchema.describe('Check definition (regex, length, keyword, cost, or schema)'),
  sourceMomentId: z
    .string()
    .optional()
    .describe('Optional Decision Moment ID the rule was derived from (preserves workflow-inversion provenance)'),
};

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
        'Parameters. name is 1-80 chars (Zod-enforced min/max — the same cap the persisted store applies); appears in eval_result rule_results so make it human-readable. description is optional, max 500 chars (used in dashboard tooltips). evalType determines WHEN the rule fires (must match the eval_type your evaluate_output calls use; e.g., a "completeness" rule fires on every evaluate_output where eval_type="completeness" OR eval_type="custom"). severity decides what a FAILURE of the rule does: low/medium failures only lower the weighted score (and drive dashboard sort + audit alerts); high/critical failures HARD-FAIL the evaluation — the overall `passed` is forced to false regardless of the weighted score, and the rule is listed in the response\'s `critical_failures`. Severity never changes the numeric score itself (that uses the rule\'s weight). definition.type and definition.config must match (e.g., regex_match needs config.pattern; cost_threshold needs config.max_cost; min_length needs config.min_length; max_length needs config.max_length; contains_keywords/excludes_keywords need config.keywords). Invalid configs are now REJECTED at deploy time with the offending field named, instead of deploying and then failing every evaluation. sourceMomentId is optional but recommended (preserves workflow-inversion provenance from Make-This-A-Rule composer). Defaults: severity="medium".',
        '',
        "Error modes. Throws 400 on invalid definition (Zod rejects — e.g., regex that fails safe-regex2 ReDoS check, or length > 1000 chars). Throws 400 on empty `name` or `name` over 80 chars. Any evalType/definition.type combination is valid (a regex_match rule can enforce a safety policy; a max_length rule can express completeness) — there is no category/type mismatch error. Returns 429 when HTTP rate limit exceeded. File-write failures (disk full, read-only fs) propagate as 500; the audit log is best-effort and does not block deploy.",
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
      // Server overrides the inner definition's `name` so it always matches
      // the user-facing rule name — same normalization the dashboard's
      // deploy route applies. Also keeps the tool's 80-char cap authoritative
      // (an unchecked definition.name used to reach the store and surface its
      // ZodError as a raw 500).
      const definition: CustomRuleDefinition = {
        ...(args.definition as CustomRuleDefinition),
        name: args.name,
      };

      // OSS: MCP tools operate under LOCAL_TENANT. See list-rules.ts for context.
      const rule = customRuleStore.deploy(LOCAL_TENANT, {
        name: args.name,
        description: args.description,
        evalType: args.evalType,
        severity: args.severity,
        definition,
        sourceMomentId: args.sourceMomentId,
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
            text: JSON.stringify({ rule }),
          },
        ],
      };
    },
  );
}
