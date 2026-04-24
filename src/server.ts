import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IrisConfig } from './types/index.js';
import type { IStorageAdapter } from './types/query.js';
import type { CustomRuleStore } from './custom-rule-store.js';
import { EvalEngine } from './eval/engine.js';
import { registerAllTools } from './tools/index.js';
import { registerAllResources } from './resources/index.js';
import { createCustomRuleStore } from './custom-rule-store.js';

export interface IrisServer {
  mcpServer: McpServer;
  evalEngine: EvalEngine;
  customRuleStore: CustomRuleStore;
}

export function createIrisServer(
  config: IrisConfig,
  storage: IStorageAdapter,
  customRuleStore?: CustomRuleStore,
): IrisServer {
  const mcpServer = new McpServer({
    name: config.server.name,
    version: config.server.version,
  });

  const evalEngine = new EvalEngine(config.eval.defaultThreshold, config.eval.ruleThresholds);
  // Caller can inject a shared rule store (e.g. index.ts passes the
  // same instance the HTTP dashboard uses, so a rule deployed via MCP
  // is immediately visible in the dashboard without a restart). If
  // none provided, create a fresh one loading from the default path.
  const ruleStore = customRuleStore ?? createCustomRuleStore();

  registerAllTools(mcpServer, storage, evalEngine, ruleStore);
  registerAllResources(mcpServer, storage);

  return { mcpServer, evalEngine, customRuleStore: ruleStore };
}
