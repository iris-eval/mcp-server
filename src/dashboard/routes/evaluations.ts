import { Router } from 'express';
import type { IStorageAdapter } from '../../types/query.js';
import { requireTenant } from '../../middleware/tenant.js';
import { evalQuerySchema } from '../validation.js';

export function registerEvaluationRoutes(router: Router, storage: IStorageAdapter): void {
  router.get('/evaluations', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const query = evalQuerySchema.parse(req.query);
      const result = await storage.queryEvalResults(tenantId, {
        eval_type: query.eval_type,
        passed: query.passed,
        since: query.since,
        until: query.until,
        limit: query.limit,
        offset: query.offset,
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
}
