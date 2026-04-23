import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import { LOCAL_TENANT } from '../types/tenant.js';

export function registerDashboardSummaryResource(server: McpServer, storage: IStorageAdapter): void {
  server.resource(
    'dashboard-summary',
    'iris://dashboard/summary',
    { description: 'Dashboard summary with key metrics and trends' },
    async () => {
      // OSS single-tenant: summary scopes to the local user.
      const summary = await storage.getDashboardSummary(LOCAL_TENANT);
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
