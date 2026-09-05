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
import { describeTool, ERROR_ENVELOPE_SENTENCE } from './describe.js';
import { guarded, respond } from './respond.js';

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

export const deleteRuleOutputSchema = z.looseObject({
  deleted: z.boolean().describe('true when a rule was removed; always false on a toggle'),
  rule_id: z.string().describe('the id that was asked for'),
  toggled: z.boolean().optional().describe('toggle only: true when the rule exists (also when it was already in the requested state)'),
  enabled: z.boolean().optional().describe('toggle only: the rule\'s state after the call'),
  rule: z.looseObject({}).optional().describe('toggle only: the rule as stored'),
});

export function registerDeleteRuleTool(
  server: McpServer,
  customRuleStore: CustomRuleStore,
  evalEngine: EvalEngine,
): void {
  server.registerTool(
    'delete_rule',
    {
      title: 'Delete or Disable Custom Rule',
      description: describeTool({
        summary:
          'Remove a deployed custom rule — or, with enabled, disable or re-enable it without removing it — effective on the next evaluate_output call.',
        does:
          'Without enabled: deletes the rule from ~/.iris/custom-rules.json, appends a rule.delete audit entry and unregisters it from the running engine; deleted is false when no rule has that id (already gone, or not this tenant\'s), and no audit row is written twice. ' +
          'With enabled: the rule stays with its history and provenance; false stops it firing at once and keeps it off across restarts, true brings it back under the same id; a rule.toggle audit entry is written unless the flag was already in that state. ' +
          'Past evaluations that referenced the rule are untouched either way.',
        whenNot:
          'On built-in rules: they are not in the store and cannot be deleted or disabled. To delete a trace (delete_trace). To replace a rule: deploy_rule with the same name and replace: true.',
        returns: deleteRuleOutputSchema,
        errors:
          'IRIS_STORAGE_ERROR when the store cannot be written. A malformed rule_id (not rule-<hex>) or an unknown argument is refused before the handler runs. ' +
          ERROR_ENVELOPE_SENTENCE,
        siblings: {
          deploy_rule: 'add or replace a rule',
          list_rules: 'find the id',
          evaluate_output: 'where the rule fires',
        },
      }),
      inputSchema: strictInput(inputSchema),
      outputSchema: deleteRuleOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guarded(async (args) => {
      // OSS: MCP tools operate under LOCAL_TENANT. See list-rules.ts for context.
      if (args.enabled !== undefined) {
        const rule = customRuleStore.setEnabled(LOCAL_TENANT, args.rule_id, args.enabled, 'mcp');
        if (!rule) {
          return respond(deleteRuleOutputSchema, { deleted: false, toggled: false, rule_id: args.rule_id });
        }
        // Mirror the store in the live engine, so the toggle is immediate
        // (registerRule is idempotent by id — re-enabling an already-live
        // rule does not stack a second copy).
        if (rule.enabled) {
          evalEngine.registerRule(rule.evalType, createCustomRule(rule.definition, rule.severity), rule.id);
        } else {
          evalEngine.unregisterRule(rule.id);
        }
        return respond(deleteRuleOutputSchema, { deleted: false, toggled: true, rule_id: args.rule_id, enabled: rule.enabled, rule });
      }

      const deleted = customRuleStore.delete(LOCAL_TENANT, args.rule_id, 'mcp');
      if (deleted) {
        // Hot-remove from the live engine so the rule stops firing on the
        // very next evaluate_output call — the "stops firing immediately on
        // the live process" this description promises (#332). No-op when the
        // rule was never registered in this process.
        evalEngine.unregisterRule(args.rule_id);
      }
      return respond(deleteRuleOutputSchema, { deleted, rule_id: args.rule_id });
    }),
  );
}
