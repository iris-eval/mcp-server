import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import { LOCAL_TENANT } from '../types/tenant.js';

export function registerTraceDetailResource(server: McpServer, storage: IStorageAdapter): void {
  server.resource(
    'trace-detail',
    'iris://traces/{trace_id}',
    { description: 'Full trace detail with spans and evaluation results' },
    async (uri) => {
      const traceId = uri.pathname.split('/').pop()!;
      // OSS single-tenant: MCP caller is the local user.
      const trace = await storage.getTrace(LOCAL_TENANT, traceId);

      if (!trace) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ error: 'Trace not found' }),
            },
          ],
        };
      }

      const spans = await storage.getSpansByTraceId(LOCAL_TENANT, traceId);
      const evals = await storage.getEvalsByTraceId(LOCAL_TENANT, traceId);

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ trace, spans, evals }, null, 2),
          },
        ],
      };
    },
  );
}
