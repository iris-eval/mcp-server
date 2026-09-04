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
import type { EvalEngine } from '../eval/engine.js';
import { builtInRuleRoster } from '../eval/criticality.js';
import { LOCAL_TENANT } from '../types/tenant.js';
import { strictInput } from './strict-input.js';

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
  evalEngine: EvalEngine,
): void {
  server.registerTool(
    'list_rules',
    {
      title: 'List Custom Rules',
      description: [
        'Enumerate deployed custom evaluation rules from the local rule store.',
        '',
        'Sibling tools — deploy_rule adds custom rules, delete_rule removes them, evaluate_output runs them against agent output. log_trace / get_traces / delete_trace handle the trace lifecycle separately. list_rules is the READ path for the custom-rule store; nothing else exposes the inventory.',
        '',
        'Behavior. Pure read of ~/.iris/custom-rules.json (in-memory cached; no disk read per call after server boot). No mutation, no external network. Tenant-scoped in Cloud tier; OSS returns all rules for the single local tenant. Rate-limited to 20 req/min on HTTP MCP, unlimited on stdio. Returns in <5ms.',
        '',
        'Output shape. Returns JSON: `{ "rules": [{ "id": "rule-XXXX", "name", "description", "evalType", "severity", "definition": { name, type, config, weight? }, "enabled": boolean, "createdAt": ISO timestamp, "updatedAt": ISO timestamp, "version": number, "sourceMomentId?": string }], "total": number, "enabled_count": number, "built_in": [{ "name", "category", "weight", "critical": boolean, "criticalSource": "default" | "config" }] }`. Empty `rules` array + total=0 when no custom rules are deployed. A deployed rule fires only on evaluate_output calls whose eval_type equals its evalType (or eval_type="all", which runs every bundle). `built_in` is the shipped rule set, always present and NOT narrowed by the filters; `total` and `enabled_count` count custom rules only.',
        '',
        'Why `built_in` carries criticality. A critical rule vetoes `passed` regardless of the weighted score, and which built-in rules are critical is configurable (`eval.criticalRules` / `eval.nonCriticalRules`). `critical` is the EFFECTIVE value this server applies and `criticalSource` says who decided it: `default` is the declaration on the rule itself, `config` means one of those lists named it. Read it before trusting a `passed: true` — it is how you tell "nothing was violated" from "the rule that would have vetoed is demoted on this server".',
        '',
        'Use when you need to know what custom rules are currently live (before calling evaluate_output, before deploying a similar rule to avoid duplicates, or when building a dashboard view). Filter with `eval_type` to scope to a specific category, or `enabled_only: true` to exclude disabled rules. Use get_traces to see trace data; use evaluate_output to run scoring; use list_rules only when you need the RULE INVENTORY.',
        '',
        "Don't use to count traces or evals (that's get_traces). Don't use to deploy a rule (use deploy_rule); don't use to remove one (use delete_rule). Built-in rules are not in the store and cannot be deployed, deleted or disabled — they appear under `built_in` for reference, carrying the criticality this server applies.",
        '',
        'Parameters. eval_type filter is exact-match against each rule\'s evalType field (no wildcards). enabled_only excludes rules that are deployed-but-disabled — a rule is disabled without deleting it via delete_rule with `enabled: false` (and re-enabled with `enabled: true`), or from the dashboard; disabled rules stay in the store with their history but do not fire. Both filters are AND-combined when both are set. Both are optional; with no filter, all rules return. Defaults: eval_type=undefined (no filter), enabled_only=false (returns all rules including disabled).',
        '',
        "Error modes. Returns empty list if the rule store file doesn't exist (first run). Returns 429 if HTTP rate limit exceeded. Never throws on valid input.",
      ].join('\n'),
      inputSchema: strictInput(inputSchema),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      // OSS: MCP tools operate under LOCAL_TENANT. Cloud multi-tenant
      // exposure is a v0.5 architectural item (MCP SDK doesn't pass
      // session/tenant context to tool handlers).
      let rules = customRuleStore.list(LOCAL_TENANT);
      if (args.eval_type) {
        rules = rules.filter((r) => r.evalType === args.eval_type);
      }
      if (args.enabled_only) {
        rules = rules.filter((r) => r.enabled);
      }
      const total = rules.length;
      const enabled_count = rules.filter((r) => r.enabled).length;
      /*
       * The built-in roster, with the criticality THIS engine applies.
       * Until eval.criticalRules existed, "which rules veto" was a constant
       * a reader could look up in the docs; it is now per-deployment, and a
       * caller deciding whether to trust `passed` has no other way to see
       * that a veto was promoted or demoted underneath them. Unfiltered on
       * purpose — the filters describe the custom-rule store.
       */
      const built_in = builtInRuleRoster((rule) => evalEngine.effectiveCriticality(rule)).map((r) => ({
        name: r.name,
        category: r.category,
        weight: r.weight,
        critical: r.critical,
        criticalSource: r.criticalSource,
      }));
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ rules, total, enabled_count, built_in }),
          },
        ],
      };
    },
  );
}
