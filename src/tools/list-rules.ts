/*
 * list_rules MCP tool — enumerate deployed custom rules.
 *
 * Read-only view into the custom-rule store (~/.iris/custom-rules.json).
 * Lets agents discover what rules are deployed, what each one evaluates,
 * and which are enabled — so an agent can decide whether to call
 * evaluate_output at all, and which eval_type to route through.
 *
 * Companion to deploy_rule / delete_rule. Together these replace the
 * dashboard-only Make-This-A-Rule composer when an agent (not a human)
 * needs to manage the rule set programmatically.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CustomRuleStore } from '../custom-rule-store.js';

const inputSchema = {
  eval_type: z
    .enum(['completeness', 'relevance', 'safety', 'cost', 'custom'])
    .optional()
    .describe('Filter to rules of a specific eval category'),
  enabled_only: z
    .boolean()
    .default(false)
    .describe('Return only enabled rules (excludes disabled ones)'),
};

export function registerListRulesTool(
  server: McpServer,
  customRuleStore: CustomRuleStore,
): void {
  server.registerTool(
    'list_rules',
    {
      title: 'List Custom Rules',
      description: [
        'Enumerate deployed custom evaluation rules from the local rule store.',
        '',
        'Behavior. Pure read of ~/.iris/custom-rules.json (in-memory cached; no disk read per call after server boot). No mutation, no external network. Tenant-scoped in Cloud tier; OSS returns all rules for the single local tenant. Rate-limited to 20 req/min on HTTP MCP, unlimited on stdio. Returns in <5ms.',
        '',
        'Output shape. Returns JSON: `{ "rules": [{ "id": "rule-XXXX", "name", "description?", "evalType", "severity", "definition": { type, config, weight? }, "enabled": boolean, "deployedAt": ISO timestamp, "sourceMomentId?": string }], "total": number, "enabled_count": number }`. Empty array + total=0 when no rules deployed.',
        '',
        'Use when you need to know what custom rules are currently live (before calling evaluate_output, before deploying a similar rule to avoid duplicates, or when building a dashboard view). Filter with `eval_type` to scope to a specific category, or `enabled_only: true` to exclude disabled rules. Use get_traces to see trace data; use evaluate_output to run scoring; use list_rules only when you need the RULE INVENTORY.',
        '',
        "Don't use to count traces or evals (that's get_traces). Don't use to inspect built-in (non-custom) rules — those ship with the iris binary and are listed in docs/api-reference.md, not in the rule store. Don't use to deploy a rule (use deploy_rule); don't use to remove one (use delete_rule).",
        '',
        "Error modes. Returns empty list if the rule store file doesn't exist (first run). Returns 429 if HTTP rate limit exceeded. Never throws on valid input.",
      ].join('\n'),
      inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      let rules = customRuleStore.list();
      if (args.eval_type) {
        rules = rules.filter((r) => r.evalType === args.eval_type);
      }
      if (args.enabled_only) {
        rules = rules.filter((r) => r.enabled);
      }
      const total = rules.length;
      const enabled_count = rules.filter((r) => r.enabled).length;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ rules, total, enabled_count }),
          },
        ],
      };
    },
  );
}
