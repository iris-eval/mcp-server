import type { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import type { EvalEngine } from '../eval/engine.js';
import type { CustomRuleStore } from '../custom-rule-store.js';
import { registerLogTraceTool, logTraceOutputSchema } from './log-trace.js';
import { registerEvaluateOutputTool } from './evaluate-output.js';
import { registerGetTracesTool, getTracesOutputSchema } from './get-traces.js';
import { registerCompareRunsTool, compareRunsOutputSchema } from './compare-runs.js';
import { registerEvaluateRunsTool, evaluateRunsOutputSchema } from './evaluate-runs.js';
import { registerCompareTracesTool, compareTracesOutputSchema } from './compare-traces.js';
import { registerListRulesTool, listRulesOutputSchema } from './list-rules.js';
import { registerDeployRuleTool, deployRuleOutputSchema } from './deploy-rule.js';
import { registerDeleteRuleTool, deleteRuleOutputSchema } from './delete-rule.js';
import { registerDeleteTraceTool, deleteTraceOutputSchema } from './delete-trace.js';
import { registerEvaluateWithLLMJudgeTool, judgeOutputSchema } from './evaluate-with-llm-judge.js';
import { registerVerifyCitationsTool, verifyCitationsOutputSchema } from './verify-citations.js';
import { dormantRulesFrom } from '../eval/dormant.js';
import { evaluateOutputResponseSchema } from '../eval/response-schema.js';
import { LOCAL_TENANT } from '../types/tenant.js';

/**
 * Every tool this server registers, by name. The capabilities object
 * lists it, the docs contract checks prose against it, and a test asserts
 * it equals what tools/list returns — so a tool added below without a
 * name here (or the reverse) fails before it ships.
 */
export const TOOL_NAMES = [
  'log_trace',
  'evaluate_output',
  'get_traces',
  'list_rules',
  'deploy_rule',
  'delete_rule',
  'delete_trace',
  'evaluate_with_llm_judge',
  'verify_citations',
  'compare_runs',
  'compare_traces',
  'evaluate_runs',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * The full output schema of every tool — the one each response is parsed
 * through. tools/list advertises only its top level (src/tools/advertise.ts);
 * the meaning of each field is served from here in iris://capabilities.
 */
export const OUTPUT_SCHEMAS: Record<ToolName, z.ZodObject<z.ZodRawShape>> = {
  log_trace: logTraceOutputSchema,
  evaluate_output: evaluateOutputResponseSchema,
  get_traces: getTracesOutputSchema,
  list_rules: listRulesOutputSchema,
  deploy_rule: deployRuleOutputSchema,
  delete_rule: deleteRuleOutputSchema,
  delete_trace: deleteTraceOutputSchema,
  evaluate_with_llm_judge: judgeOutputSchema,
  verify_citations: verifyCitationsOutputSchema,
  compare_runs: compareRunsOutputSchema,
  compare_traces: compareTracesOutputSchema,
  evaluate_runs: evaluateRunsOutputSchema,
};

export function registerAllTools(
  server: McpServer,
  storage: IStorageAdapter,
  evalEngine: EvalEngine,
  customRuleStore: CustomRuleStore,
): void {
  registerLogTraceTool(server, storage, evalEngine, {
    dormant: () => dormantRulesFrom(customRuleStore.quarantined(LOCAL_TENANT)),
    rulesChanged: () => customRuleStore.changesSinceStart(LOCAL_TENANT),
  });
  registerEvaluateOutputTool(server, storage, evalEngine, {
    dormant: () => dormantRulesFrom(customRuleStore.quarantined(LOCAL_TENANT)),
    rulesChanged: () => customRuleStore.changesSinceStart(LOCAL_TENANT),
  });
  registerGetTracesTool(server, storage);
  registerCompareRunsTool(server, storage);
  registerCompareTracesTool(server, storage);
  registerEvaluateRunsTool(server, storage, evalEngine, {
    rulesChanged: () => customRuleStore.changesSinceStart(LOCAL_TENANT),
  });
  registerListRulesTool(server, customRuleStore, evalEngine);
  registerDeployRuleTool(server, customRuleStore, evalEngine);
  registerDeleteRuleTool(server, customRuleStore, evalEngine);
  registerDeleteTraceTool(server, storage, customRuleStore.auditPath);
  registerEvaluateWithLLMJudgeTool(server, storage, evalEngine);
  registerVerifyCitationsTool(server, storage, evalEngine);
}
