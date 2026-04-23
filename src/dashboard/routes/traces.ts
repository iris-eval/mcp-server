import { Router } from 'express';
import type { IStorageAdapter } from '../../types/query.js';
import { requireTenant } from '../../middleware/tenant.js';
import { traceQuerySchema } from '../validation.js';

export function registerTraceRoutes(router: Router, storage: IStorageAdapter): void {
  router.get('/traces', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const query = traceQuerySchema.parse(req.query);
      const result = await storage.queryTraces(tenantId, {
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
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid query parameters', details: (err as unknown as { issues: unknown }).issues });
        return;
      }
      throw err;
    }
  });

  router.get('/traces/:id', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const trace = await storage.getTrace(tenantId, req.params.id);
      if (!trace) {
        res.status(404).json({ error: 'Trace not found' });
        return;
      }
      const spans = await storage.getSpansByTraceId(tenantId, req.params.id);
      const evals = await storage.getEvalsByTraceId(tenantId, req.params.id);
      res.json({ trace, spans, evals });
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid query parameters', details: (err as unknown as { issues: unknown }).issues });
        return;
      }
      throw err;
    }
  });
}
