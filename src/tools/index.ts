import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import type { EvalEngine } from '../eval/engine.js';
import type { CustomRuleStore } from '../custom-rule-store.js';
import { registerLogTraceTool } from './log-trace.js';
import { registerEvaluateOutputTool } from './evaluate-output.js';
import { registerGetTracesTool } from './get-traces.js';
import { registerListRulesTool } from './list-rules.js';
import { registerDeployRuleTool } from './deploy-rule.js';
import { registerDeleteRuleTool } from './delete-rule.js';
import { registerDeleteTraceTool } from './delete-trace.js';
import { registerEvaluateWithLLMJudgeTool } from './evaluate-with-llm-judge.js';
import { registerVerifyCitationsTool } from './verify-citations.js';

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
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export function registerAllTools(
  server: McpServer,
  storage: IStorageAdapter,
  evalEngine: EvalEngine,
  customRuleStore: CustomRuleStore,
): void {
  registerLogTraceTool(server, storage);
  registerEvaluateOutputTool(server, storage, evalEngine);
  registerGetTracesTool(server, storage);
  registerListRulesTool(server, customRuleStore, evalEngine);
  registerDeployRuleTool(server, customRuleStore, evalEngine);
  registerDeleteRuleTool(server, customRuleStore, evalEngine);
  registerDeleteTraceTool(server, storage);
  registerEvaluateWithLLMJudgeTool(server, storage);
  registerVerifyCitationsTool(server, storage);
}
