import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import { registerDashboardSummaryResource } from './dashboard-summary.js';
import { registerTraceDetailResource } from './trace-detail.js';

export function registerAllResources(server: McpServer, storage: IStorageAdapter): void {
  registerDashboardSummaryResource(server, storage);
  registerTraceDetailResource(server, storage);
}
