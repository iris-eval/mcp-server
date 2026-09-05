/*
 * list_rules MCP tool — the rule inventory.
 *
 * Two halves. `built_in` is the shipped roster with everything a caller
 * needs to trust a verdict: what each rule is (kind, mechanism), what it
 * reads (needs — absent means it skips), the question it answers, the
 * criticality THIS server applies and who decided it, and its published
 * accuracy. `rules` is the custom-rule store (~/.iris/custom-rules.json),
 * the read path deploy_rule and delete_rule write to.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CustomRuleStore } from '../custom-rule-store.js';
import type { EvalEngine } from '../eval/engine.js';
import { builtInRuleRoster } from '../eval/criticality.js';
import { ruleProof } from '../capabilities.js';
import { LOCAL_TENANT } from '../types/tenant.js';
import { strictInput } from './strict-input.js';
import { describeTool, ERROR_ENVELOPE_SENTENCE } from './describe.js';
import { guarded, respond } from './respond.js';
import { PROOF_RESOURCE_URI } from '../resources/uris.js';

const inputSchema = {
  eval_type: z
    .enum(['completeness', 'relevance', 'safety', 'cost', 'custom'])
    .optional()
    .describe('Filter the custom rules to one eval category (exact match); built_in is never filtered'),
  enabled_only: z
    .boolean()
    .default(false)
    .describe('Return only enabled custom rules (a rule disabled with delete_rule stays in the store and does not fire)'),
};

export const listRulesOutputSchema = z.looseObject({
  rules: z.array(z.looseObject({ id: z.string(), name: z.string() })).describe('the deployed custom rules after the filters: id, name, description, evalType, severity, definition, enabled, createdAt, updatedAt, version, sourceMomentId'),
  total: z.number().int().describe('custom rules after the filters'),
  enabled_count: z.number().int().describe('of those, how many are enabled'),
  built_in: z.array(z.looseObject({ name: z.string() })).describe('the shipped roster, never filtered: name, category, description, weight, kind, mechanism, needs, question, classes, version, the EFFECTIVE critical flag with criticalSource, and proof (published precision, recall, intervals and ppvAt from https://iris-eval.com/proof; null where the proof is a conformance check)'),
  quarantined: z.array(z.unknown()).describe('entries in the store this version could not validate; they do not fire and are never deleted by a deploy'),
});

export function registerListRulesTool(
  server: McpServer,
  customRuleStore: CustomRuleStore,
  evalEngine: EvalEngine,
): void {
  server.registerTool(
    'list_rules',
    {
      title: 'List Rules',
      description: describeTool({
        summary:
          'The rule inventory: the built-in roster with what each rule needs, the criticality this server applies and its published accuracy, plus every deployed custom rule.',
        does:
          'Read-only, no network. built_in is the shipped roster and is never narrowed by the filters. For each rule: kind (measurement, detection, inference, judgment, policy, verification), mechanism, needs (the inputs it reads — absent means the rule skips, never passes), question, classes, version, weight, ' +
          'the EFFECTIVE critical flag with criticalSource (default, or config when eval.criticalRules / eval.nonCriticalRules changed it on this server — read it before trusting a passed: true), ' +
          'and proof: precision and recall with 95% intervals and the positive predictive value at four prevalences, the numbers published at https://iris-eval.com/proof. ' +
          'rules is the custom-rule store, filterable by eval_type and enabled_only; total and enabled_count count custom rules. quarantined lists store entries this version could not validate; they do not fire.',
        whenNot:
          'To count traces (get_traces). To add, remove or pause a rule (deploy_rule, delete_rule). Built-in rules are not in the store and cannot be deployed, deleted or disabled.',
        returns: listRulesOutputSchema,
        errors:
          'IRIS_INTERNAL_ERROR if the store file cannot be read. A missing store file is an empty list, not an error. ' +
          ERROR_ENVELOPE_SENTENCE,
        siblings: {
          deploy_rule: 'add a custom rule',
          delete_rule: 'remove, disable or re-enable one',
          evaluate_output: 'run the rules',
        },
      }),
      inputSchema: strictInput(inputSchema),
      outputSchema: listRulesOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(async (args) => {
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
        ...r,
        proof: ruleProof(r.name),
      }));
      return respond(
        listRulesOutputSchema,
        { rules, total, enabled_count, built_in, quarantined: customRuleStore.quarantined(LOCAL_TENANT) },
        [{ uri: PROOF_RESOURCE_URI, name: 'proof', description: 'The published accuracy of every measured rule, with the corpus it was measured on' }],
      );
    }),
  );
}
