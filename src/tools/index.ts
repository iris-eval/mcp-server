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

export function registerAllTools(
  server: McpServer,
  storage: IStorageAdapter,
  evalEngine: EvalEngine,
  customRuleStore: CustomRuleStore,
): void {
  registerLogTraceTool(server, storage);
  registerEvaluateOutputTool(server, storage, evalEngine);
  registerGetTracesTool(server, storage);
  registerListRulesTool(server, customRuleStore);
  registerDeployRuleTool(server, customRuleStore);
  registerDeleteRuleTool(server, customRuleStore);
  registerDeleteTraceTool(server, storage);
  registerEvaluateWithLLMJudgeTool(server, storage);
}
