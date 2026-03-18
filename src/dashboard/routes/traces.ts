import { Router } from 'express';
import type { IStorageAdapter } from '../../types/query.js';
import type { Trace } from '../../types/trace.js';
import { traceQuerySchema, exportTraceQuerySchema } from '../validation.js';

function tracesToCsv(traces: Trace[]): string {
  const headers = ['trace_id', 'agent_name', 'framework', 'latency_ms', 'cost_usd', 'tool_calls_count', 'timestamp'];
  const escape = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = traces.map((t) => [
    t.trace_id,
    t.agent_name,
    t.framework ?? '',
    t.latency_ms ?? '',
    t.cost_usd ?? '',
    t.tool_calls ? t.tool_calls.length : 0,
    t.timestamp,
  ].map(escape).join(','));
  return [headers.join(','), ...rows].join('\n');
}

export function registerTraceRoutes(router: Router, storage: IStorageAdapter): void {
  router.get('/traces/export', async (req, res) => {
    const query = exportTraceQuerySchema.parse(req.query);
    const result = await storage.queryTraces({
      filter: {
        agent_name: query.agent_name,
        framework: query.framework,
        since: query.since,
        until: query.until,
      },
      limit: 10000,
      offset: 0,
      sort_by: query.sort_by,
      sort_order: query.sort_order,
    });

    const filename = `traces-export.${query.format}`;
    if (query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(tracesToCsv(result.traces));
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.json(result.traces);
    }
  });

  router.get('/traces', async (req, res) => {
    const query = traceQuerySchema.parse(req.query);
    const result = await storage.queryTraces({
      filter: {
        agent_name: query.agent_name,
        framework: query.framework,
        since: query.since,
        until: query.until,
      },
      limit: query.limit,
      offset: query.offset,
      sort_by: query.sort_by,
      sort_order: query.sort_order,
    });
    res.json(result);
  });

  router.get('/traces/:id', async (req, res) => {
    const trace = await storage.getTrace(req.params.id);
    if (!trace) {
      res.status(404).json({ error: 'Trace not found' });
      return;
    }
    const spans = await storage.getSpansByTraceId(req.params.id);
    const evals = await storage.getEvalsByTraceId(req.params.id);
    res.json({ trace, spans, evals });
  });
}
