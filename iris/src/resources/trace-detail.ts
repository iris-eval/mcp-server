import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';

export function registerTraceDetailResource(server: McpServer, storage: IStorageAdapter): void {
  server.resource(
    'trace-detail',
    'iris://traces/{trace_id}',
    { description: 'Full trace detail with spans and evaluation results' },
    async (uri) => {
      const traceId = uri.pathname.split('/').pop()!;
      const trace = await storage.getTrace(traceId);

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

      const spans = await storage.getSpansByTraceId(traceId);
      const evals = await storage.getEvalsByTraceId(traceId);

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
