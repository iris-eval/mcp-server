/*
 * delete_rule MCP tool — remove a deployed custom rule, or disable /
 * re-enable one without removing it.
 *
 * Destructive counterpart to deploy_rule. Removes the rule from
 * ~/.iris/custom-rules.json AND unregisters it from the live eval
 * engine, so it stops firing on the very next evaluate_output call —
 * no restart needed. Appends a `rule.delete` entry to the audit log.
 *
 * With `enabled` present the call is a TOGGLE instead: the rule stays in
 * the store with its history and provenance, is unregistered from (or
 * re-registered with) the live engine, and a `rule.toggle` audit row is
 * written. The descriptions used to point at "the dashboard's toggle
 * affordance" for this — which did not exist on any surface; the store
 * had setEnabled() and nothing called it. This is the MCP path to it.
 *
 * Past eval_results that referenced this rule stay intact — the
 * history is preserved even after the rule is removed. The audit
 * log row is the permanent record that the rule ever existed.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CustomRuleStore } from '../custom-rule-store.js';
import type { EvalEngine } from '../eval/engine.js';
import { createCustomRule } from '../eval/rules/custom.js';
import { LOCAL_TENANT } from '../types/tenant.js';
import { strictInput } from './strict-input.js';

const inputSchema = {
  rule_id: z
    .string()
    .regex(/^rule-[a-z0-9]+$/)
    .describe('Rule id to delete or toggle (format: rule-<hex>); obtained from list_rules or deploy_rule response'),
  enabled: z
    .boolean()
    .optional()
    .describe('When present the rule is NOT deleted: false DISABLES it (kept in the store, stops firing immediately, history and provenance preserved); true RE-ENABLES a disabled rule. Omit to delete'),
};

export function registerDeleteRuleTool(
  server: McpServer,
  customRuleStore: CustomRuleStore,
  evalEngine: EvalEngine,
): void {
  server.registerTool(
    'delete_rule',
    {
      title: 'Delete or Disable Custom Rule',
      description: [
        'Remove a deployed custom evaluation rule — or, with `enabled`, disable / re-enable it without removing it. Either way the change takes effect on the next evaluate_output call; past eval_results that referenced the rule are preserved.',
        '',
        'Sibling tools — deploy_rule adds custom rules, list_rules enumerates them (including disabled ones, with `enabled: false`), evaluate_output runs them. delete_trace handles trace deletion (separate concern); log_trace / get_traces handle trace I/O. delete_rule is the DESTRUCTIVE remove path for the custom-rule store and the only MCP path that toggles a rule; it does NOT touch traces, eval_results, or built-in (non-custom) rules.',
        '',
        'Behavior. Without `enabled`: DESTRUCTIVE — rewrites ~/.iris/custom-rules.json without the deleted row and appends a `rule.delete` entry to the audit log (~/.iris/audit.log). Not idempotent: deleting an already-deleted rule returns `deleted: false` rather than re-emitting the audit row. The rule stops firing immediately on the live process. With `enabled`: NOT destructive — the rule row stays, its `enabled` flag and `updatedAt` change, a `rule.toggle` audit entry is appended (none if the flag was already in that state), and the live engine unregisters (false) or re-registers (true) the rule so the change is immediate; a disabled rule is not loaded at the next boot either. Historical eval_results that reference this rule_id stay in the database — drift analytics + audit trail remain valid. Tenant-scoped in Cloud tier; OSS operates on LOCAL_TENANT. Rate-limited to 20 req/min on HTTP MCP.',
        '',
        'Output shape. Delete: `{ "deleted": boolean, "rule_id": string }` — `deleted=true` if a row was removed; `deleted=false` if no rule with that id existed. Toggle (enabled given): `{ "deleted": false, "toggled": boolean, "rule_id": string, "enabled"?: boolean, "rule"?: { ...the rule } }` — `toggled=true` with the rule\'s current state when the id exists (also when it was already in the requested state), `toggled=false` and no `rule` when it does not.',
        '',
        "Use when a custom rule is obsolete (behavior changed, false positives unacceptable, replaced by a better rule). Typical flow: list_rules → identify the stale one → delete_rule(id). Combine with deploy_rule to replace: delete_rule(oldId) + deploy_rule(newDefinition), or deploy_rule with the same name and replace:true. To temporarily PAUSE a rule — false positives to investigate, a rollout to stage — pass `enabled: false` instead of deleting; it keeps the id, the provenance and the history, and `enabled: true` brings it back with the same id.",
        '',
        "Don't use on built-in (non-custom) rules — the rule_id format checks for `rule-<hex>` custom ids; built-ins aren't in the store. Don't use to delete a trace or eval result (use delete_trace for traces; eval_results deletion is not exposed per row — they fall under data retention and `--purge`).",
        '',
        'Parameters. rule_id must match `rule-<lowercase-hex>` format (Zod regex). Format mismatch fails Zod with 400 BEFORE the store is touched. Cross-tenant rule_ids return `deleted: false` / `toggled: false` silently — they\'re invisible to the caller\'s tenant rather than producing a not-found error (prevents enumeration attacks). The rule_id you pass is exactly what list_rules returned in `id` or what deploy_rule returned in `rule.id`. enabled is optional: omit to delete, false to disable, true to re-enable.',
        '',
        "Error modes. Throws 400 on malformed rule_id (wrong prefix) or an unknown argument. Returns `{deleted: false}` (or `{toggled: false}`) if rule_id doesn't match any deployed rule (not an error — idempotent-ish). Returns 429 on HTTP rate limit. File-write failures propagate as 500.",
      ].join('\n'),
      inputSchema: strictInput(inputSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      // OSS: MCP tools operate under LOCAL_TENANT. See list-rules.ts for context.
      if (args.enabled !== undefined) {
        const rule = customRuleStore.setEnabled(LOCAL_TENANT, args.rule_id, args.enabled, 'mcp');
        if (!rule) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ deleted: false, toggled: false, rule_id: args.rule_id }) }],
          };
        }
        // Mirror the store in the live engine, so the toggle is immediate
        // (registerRule is idempotent by id — re-enabling an already-live
        // rule does not stack a second copy).
        if (rule.enabled) {
          evalEngine.registerRule(rule.evalType, createCustomRule(rule.definition, rule.severity), rule.id);
        } else {
          evalEngine.unregisterRule(rule.id);
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ deleted: false, toggled: true, rule_id: args.rule_id, enabled: rule.enabled, rule }),
            },
          ],
        };
      }

      const deleted = customRuleStore.delete(LOCAL_TENANT, args.rule_id, 'mcp');
      if (deleted) {
        // Hot-remove from the live engine so the rule stops firing on the
        // very next evaluate_output call — the "stops firing immediately on
        // the live process" this description promises (#332). No-op when the
        // rule was never registered in this process.
        evalEngine.unregisterRule(args.rule_id);
      }
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
