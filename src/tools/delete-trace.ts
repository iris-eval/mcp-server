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

const inputSchema = {
  trace_id: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .describe('Trace id to delete (32-hex lowercase; obtained from log_trace response or get_traces)'),
};

export function registerDeleteTraceTool(
  server: McpServer,
  storage: IStorageAdapter,
): void {
  server.registerTool(
    'delete_trace',
    {
      title: 'Delete Trace',
      description: [
        'Remove a single trace by id. Cascades to spans; eval_results keep the score history with trace_id NULLed.',
        '',
        'Behavior. DESTRUCTIVE — SQL DELETE scoped to the caller\'s tenant_id. Cascades: spans belonging to this trace are deleted (FK ON DELETE CASCADE); eval_results that referenced this trace have their trace_id set to NULL (FK ON DELETE SET NULL) so aggregate dashboards + historical scores remain valid even after the trace is gone. Not idempotent: deleting an already-deleted trace returns `deleted: false`. Does not emit an audit log entry in v0.4 — traces are user-scope data, not policy changes. Rate-limited to 20 req/min on HTTP MCP.',
        '',
        'Output shape. Returns JSON: `{ "deleted": boolean, "trace_id": string }`. `deleted=true` if a row was removed; `deleted=false` if no trace with that id existed (or it belonged to a different tenant — cross-tenant deletes silently fail).',
        '',
        "Use when a trace was captured in error, contains sensitive data that must be removed for compliance (e.g., a customer exercises GDPR right-to-erasure), or when cleaning up test data. Combine with get_traces to find candidates: query with filters → review → delete_trace(id) per target. For bulk time-window deletion, use `deleteTracesOlderThan` via the CLI / retention config — delete_trace is the single-row surgical path.",
        '',
        "Don't use to clean up OLD data in bulk (use retention config with --retention-days). Don't use to PAUSE a trace — traces are immutable once stored; there's nothing to pause. Don't use to delete eval_results — eval_results survive their trace's deletion intentionally (for audit + drift analysis); they're pruned only by retention.",
        '',
        "Error modes. Throws 400 on malformed trace_id (wrong format: not 32-char lowercase hex). Returns `{deleted: false}` when the id doesn't exist in the caller's tenant (not an error — the trace may simply have been deleted already). Returns 429 on HTTP rate limit. Storage failures propagate as 500.",
      ].join('\n'),
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      const deleted = await storage.deleteTrace(LOCAL_TENANT, args.trace_id);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ deleted, trace_id: args.trace_id }),
          },
        ],
      };
    },
  );
}
