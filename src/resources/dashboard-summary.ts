import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';

export function registerDashboardSummaryResource(server: McpServer, storage: IStorageAdapter): void {
  server.resource(
    'dashboard-summary',
    'iris://dashboard/summary',
    { description: 'Dashboard summary with key metrics and trends' },
    async () => {
      const summary = await storage.getDashboardSummary();
      return {
        contents: [
          {
            uri: 'iris://dashboard/summary',
            mimeType: 'application/json',
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    },
  );
}
