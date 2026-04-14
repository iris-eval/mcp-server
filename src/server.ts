import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IrisConfig } from './types/index.js';
import type { IStorageAdapter } from './types/query.js';
import { EvalEngine } from './eval/engine.js';
import { registerAllTools } from './tools/index.js';
import { registerAllResources } from './resources/index.js';

export interface IrisServer {
  mcpServer: McpServer;
  evalEngine: EvalEngine;
}

export function createIrisServer(config: IrisConfig, storage: IStorageAdapter): IrisServer {
  const mcpServer = new McpServer({
    name: config.server.name,
    version: config.server.version,
  });

  const evalEngine = new EvalEngine(config.eval.defaultThreshold, config.eval.ruleThresholds);

  registerAllTools(mcpServer, storage, evalEngine);
  registerAllResources(mcpServer, storage);

  return { mcpServer, evalEngine };
}
