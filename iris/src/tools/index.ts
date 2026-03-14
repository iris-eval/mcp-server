import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import type { EvalEngine } from '../eval/engine.js';
import { registerLogTraceTool } from './log-trace.js';
import { registerEvaluateOutputTool } from './evaluate-output.js';
import { registerGetTracesTool } from './get-traces.js';

export function registerAllTools(
  server: McpServer,
  storage: IStorageAdapter,
  evalEngine: EvalEngine,
): void {
  registerLogTraceTool(server, storage);
  registerEvaluateOutputTool(server, storage, evalEngine);
  registerGetTracesTool(server, storage);
}
