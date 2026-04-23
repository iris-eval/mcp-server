import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import { generateTraceId, generateSpanId } from '../utils/ids.js';
import { LOCAL_TENANT } from '../types/tenant.js';

const ToolCallSchema = z.object({
  tool_name: z.string(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  latency_ms: z.number().optional(),
  error: z.string().optional(),
});

const SpanSchema = z.object({
  span_id: z.string().optional(),
  parent_span_id: z.string().optional(),
  name: z.string(),
  kind: z.enum(['INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER', 'LLM', 'TOOL']).default('INTERNAL'),
  status_code: z.enum(['UNSET', 'OK', 'ERROR']).default('UNSET'),
  status_message: z.string().optional(),
  start_time: z.string(),
  end_time: z.string().optional(),
  attributes: z.record(z.unknown()).optional(),
  events: z.array(z.object({
    name: z.string(),
    timestamp: z.string(),
    attributes: z.record(z.unknown()).optional(),
  })).optional(),
});

const TokenUsageSchema = z.object({
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
});

const inputSchema = {
  agent_name: z.string().describe('Name of the agent'),
  framework: z.string().optional().describe('Agent framework name'),
  input: z.string().optional().describe('Agent input text'),
  output: z.string().optional().describe('Agent output text'),
  tool_calls: z.array(ToolCallSchema).optional().describe('Tool calls made during execution'),
  latency_ms: z.number().optional().describe('Total execution time in milliseconds'),
  token_usage: TokenUsageSchema.optional().describe('Token usage breakdown'),
  cost_usd: z.number().optional().describe('Total cost in USD'),
  metadata: z.record(z.unknown()).optional().describe('Arbitrary metadata'),
  spans: z.array(SpanSchema).optional().describe('Detailed execution spans'),
  timestamp: z.string().optional().describe('Trace timestamp (ISO 8601)'),
};

export function registerLogTraceTool(server: McpServer, storage: IStorageAdapter): void {
  server.registerTool(
    'log_trace',
    {
      title: 'Log Trace',
      description: 'Log an agent execution trace with spans, tool calls, and metrics',
      inputSchema,
    },
    async (args) => {
      const traceId = generateTraceId();
      const timestamp = args.timestamp ?? new Date().toISOString();

      const trace = {
        trace_id: traceId,
        agent_name: args.agent_name,
        framework: args.framework,
        input: args.input,
        output: args.output,
        tool_calls: args.tool_calls,
        latency_ms: args.latency_ms,
        token_usage: args.token_usage,
        cost_usd: args.cost_usd,
        metadata: args.metadata as Record<string, unknown> | undefined,
        timestamp,
        spans: args.spans?.map((s) => ({
          ...s,
          span_id: s.span_id ?? generateSpanId(),
          trace_id: traceId,
        })),
      };

      await storage.insertTrace(LOCAL_TENANT, trace);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ trace_id: traceId, status: 'stored' }),
          },
        ],
      };
    },
  );
}
