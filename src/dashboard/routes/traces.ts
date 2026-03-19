import { Router } from 'express';
import type { IStorageAdapter } from '../../types/query.js';
import { traceQuerySchema, exportTraceQuerySchema } from '../validation.js';
import { toCsv } from './csv.js';

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
      limit: query.limit,
      offset: 0,
      sort_by: query.sort_by,
      sort_order: query.sort_order,
    });

    const filename = `traces-export.${query.format}`;
    if (query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(toCsv(
        ['trace_id', 'agent_name', 'framework', 'latency_ms', 'cost_usd', 'tool_calls_count', 'timestamp'],
        result.traces.map((t) => [
          t.trace_id,
          t.agent_name,
          t.framework ?? '',
          t.latency_ms ?? '',
          t.cost_usd ?? '',
          t.tool_calls ? t.tool_calls.length : 0,
          t.timestamp,
        ]),
      ));
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
