/*
 * delete_trace MCP tool — remove a single trace by id.
 *
 * Destructive. Scoped to tenant — an agent cannot delete a trace
 * belonging to another tenant (cross-tenant deletes look like
 * "id not found").
 *
 * Cascades to spans via FK ON DELETE CASCADE. eval_results for the
 * trace have their trace_id set to NULL (score history survives
 * even after the underlying trace is gone).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import { LOCAL_TENANT } from '../types/tenant.js';
import { strictInput } from './strict-input.js';
import { describeTool, ERROR_ENVELOPE_SENTENCE } from './describe.js';
import { guarded, respond } from './respond.js';

const inputSchema = {
  trace_id: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .describe('Trace id to delete (32-hex lowercase; obtained from log_trace response or get_traces)'),
};

export const deleteTraceOutputSchema = z.looseObject({
  deleted: z.boolean().describe('true when a trace row was removed; false when no trace with that id existed for this tenant'),
  trace_id: z.string().describe('the id that was asked for'),
});

export function registerDeleteTraceTool(
  server: McpServer,
  storage: IStorageAdapter,
): void {
  server.registerTool(
    'delete_trace',
    {
      title: 'Delete Trace',
      description: describeTool({
        summary: 'Remove one stored trace by id; its spans go with it, and its evaluations keep their scores with trace_id cleared.',
        does:
          "Deletes the trace row for the caller's tenant. Spans cascade. Evaluations linked to it are kept for history with their trace_id set to null. " +
          "deleted is false when no trace has that id — already removed, or not this tenant's — and that is not an error. " +
          'No audit entry is written: traces are user data, not policy. For bulk expiry set retention.days in config.json (the sweep runs at startup); this is the single-row path.',
        whenNot:
          'To expire old data in bulk (retention.days). To delete evaluations: they are not deleted per row; retention and --purge cover them. To pause anything: traces are immutable, there is nothing to pause.',
        returns: deleteTraceOutputSchema,
        errors:
          'IRIS_STORAGE_ERROR when the delete cannot run. A malformed trace_id (not 32 lowercase hex) is refused before the handler runs. ' +
          ERROR_ENVELOPE_SENTENCE,
        siblings: {
          log_trace: 'store a trace',
          get_traces: 'find the trace to delete',
          delete_rule: 'the equivalent for custom rules',
        },
      }),
      inputSchema: strictInput(inputSchema),
      outputSchema: deleteTraceOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guarded(async (args) => {
      const deleted = await storage.deleteTrace(LOCAL_TENANT, args.trace_id);
      return respond(deleteTraceOutputSchema, { deleted, trace_id: args.trace_id });
    }),
  );
}
