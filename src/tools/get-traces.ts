import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';

const inputSchema = {
  agent_name: z.string().optional().describe('Filter by agent name'),
  framework: z.string().optional().describe('Filter by framework'),
  since: z.string().optional().describe('ISO timestamp lower bound'),
  until: z.string().optional().describe('ISO timestamp upper bound'),
  min_score: z.number().optional().describe('Minimum eval score filter'),
  max_score: z.number().optional().describe('Maximum eval score filter'),
  limit: z.number().default(50).describe('Results per page'),
  offset: z.number().default(0).describe('Pagination offset'),
  sort_by: z.enum(['timestamp', 'latency_ms', 'cost_usd']).default('timestamp').describe('Sort field'),
  sort_order: z.enum(['asc', 'desc']).default('desc').describe('Sort order'),
  include_summary: z.boolean().default(false).describe('Include dashboard summary stats'),
};

export function registerGetTracesTool(server: McpServer, storage: IStorageAdapter): void {
  server.registerTool(
    'get_traces',
    {
      title: 'Get Traces',
      description: 'Query stored traces with filters, pagination, and optional summary stats',
      inputSchema,
    },
    async (args) => {
      const result = await storage.queryTraces({
        filter: {
          agent_name: args.agent_name,
          framework: args.framework,
          since: args.since,
          until: args.until,
          min_score: args.min_score,
          max_score: args.max_score,
        },
        limit: args.limit,
        offset: args.offset,
        sort_by: args.sort_by as 'timestamp' | 'latency_ms' | 'cost_usd',
        sort_order: args.sort_order as 'asc' | 'desc',
      });

      const response: Record<string, unknown> = {
        traces: result.traces,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      };

      if (args.include_summary) {
        response.summary = await storage.getDashboardSummary();
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(response),
          },
        ],
      };
    },
  );
}
