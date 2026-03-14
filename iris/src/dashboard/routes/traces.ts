import { Router } from 'express';
import type { IStorageAdapter } from '../../types/query.js';
import { traceQuerySchema } from '../validation.js';

export function registerTraceRoutes(router: Router, storage: IStorageAdapter): void {
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
