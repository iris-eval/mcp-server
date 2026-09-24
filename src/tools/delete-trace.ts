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
import { advertisedOutput } from './advertise.js';
import { guarded, respond } from './respond.js';
import { appendAuditEntry } from '../custom-rule-store.js';

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
  /** The rule store's audit log, so a deletion lands where iris://audit and the Audit page read. */
  auditPath?: string,
): void {
  server.registerTool(
    'delete_trace',
    {
      title: 'Delete Trace',
      description: describeTool({
        summary:
          'Remove one stored trace by id; its spans go with it, and every evaluation linked to it keeps its verdict and loses its text.',
        does:
          'Linked evaluations keep their verdicts and scores; their text is erased and erased_at is stamped. deleted is false when no trace has that id. Every deletion is audited at iris://audit.',
        whenNot:
          'To expire data in bulk (retention.days). To change a trace: traces are immutable.',
        returns: deleteTraceOutputSchema,
        errors:
          'IRIS_STORAGE_ERROR. A malformed trace_id is refused. ' + ERROR_ENVELOPE_SENTENCE,
        siblings: {
          log_trace: 'store a trace',
          get_traces: 'find the trace to delete',
          delete_rule: 'the equivalent for custom rules',
        },
      }),
      inputSchema: strictInput(inputSchema),
      outputSchema: advertisedOutput(deleteTraceOutputSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guarded(async (args) => {
      const deleted = await storage.deleteTrace(LOCAL_TENANT, args.trace_id);
      if (deleted) {
        appendAuditEntry(
          { ts: new Date().toISOString(), tenantId: LOCAL_TENANT, action: 'trace.delete', user: 'local', traceId: args.trace_id },
          auditPath,
        );
      }
      return respond(deleteTraceOutputSchema, { deleted, trace_id: args.trace_id });
    }),
  );
}
