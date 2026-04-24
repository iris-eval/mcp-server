/*
 * delete_rule MCP tool — remove a deployed custom rule.
 *
 * Destructive counterpart to deploy_rule. Removes the rule from
 * ~/.iris/custom-rules.json (stops firing on future evaluate_output
 * calls) and appends a `rule.delete` entry to the audit log.
 *
 * Past eval_results that referenced this rule stay intact — the
 * history is preserved even after the rule is removed. The audit
 * log row is the permanent record that the rule ever existed.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CustomRuleStore } from '../custom-rule-store.js';

const inputSchema = {
  rule_id: z
    .string()
    .regex(/^rule-[a-z0-9]+$/)
    .describe('Rule id to delete (format: rule-<hex>); obtained from list_rules or deploy_rule response'),
};

export function registerDeleteRuleTool(
  server: McpServer,
  customRuleStore: CustomRuleStore,
): void {
  server.registerTool(
    'delete_rule',
    {
      title: 'Delete Custom Rule',
      description: [
        'Remove a deployed custom evaluation rule. The rule stops firing on future evaluate_output calls; past eval_results that referenced it are preserved.',
        '',
        'Behavior. DESTRUCTIVE — rewrites ~/.iris/custom-rules.json without the deleted row and appends a `rule.delete` entry to the audit log (~/.iris/audit.log). Not idempotent: deleting an already-deleted rule returns `deleted: false` rather than re-emitting the audit row. The rule stops firing immediately on the live process. Historical eval_results that reference this rule_id stay in the database — drift analytics + audit trail remain valid. Tenant-scoped in Cloud tier; OSS operates on LOCAL_TENANT. Rate-limited to 20 req/min on HTTP MCP.',
        '',
        'Output shape. Returns JSON: `{ "deleted": boolean, "rule_id": string }`. `deleted=true` if a row was removed; `deleted=false` if no rule with that id existed.',
        '',
        "Use when a custom rule is obsolete (behavior changed, false positives unacceptable, replaced by a better rule). Typical flow: list_rules → identify the stale one → delete_rule(id). Combine with deploy_rule to replace: delete_rule(oldId) + deploy_rule(newDefinition). To temporarily disable a rule WITHOUT deletion, use the dashboard's toggle affordance instead — delete is permanent in intent (rule is gone; re-adding requires a new id).",
        '',
        "Don't use to pause a rule (toggle in the dashboard preserves history better). Don't use on built-in (non-custom) rules — the rule_id format checks for `rule-<hex>` custom ids; built-ins aren't in the store. Don't use to delete a trace or eval result (use delete_trace for traces; eval_results deletion is not exposed in v0.4 — they fall under data retention).",
        '',
        "Error modes. Throws 400 on malformed rule_id (wrong prefix). Returns `{deleted: false}` if rule_id doesn't match any deployed rule (not an error — idempotent-ish). Returns 429 on HTTP rate limit. File-write failures propagate as 500.",
      ].join('\n'),
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      const deleted = customRuleStore.delete(args.rule_id, 'mcp');
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ deleted, rule_id: args.rule_id }),
          },
        ],
      };
    },
  );
}
