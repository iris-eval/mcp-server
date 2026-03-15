import { Router } from 'express';
import type { IStorageAdapter } from '../../types/query.js';
import { evalQuerySchema } from '../validation.js';

export function registerEvaluationRoutes(router: Router, storage: IStorageAdapter): void {
  router.get('/evaluations', async (req, res) => {
    const query = evalQuerySchema.parse(req.query);
    const result = await storage.queryEvalResults({
      eval_type: query.eval_type,
      passed: query.passed,
      since: query.since,
      until: query.until,
      limit: query.limit,
      offset: query.offset,
    });
    res.json(result);
  });
}
