import { Router } from 'express';
import type { IStorageAdapter } from '../../types/query.js';
import { summaryQuerySchema } from '../validation.js';

export function registerSummaryRoutes(router: Router, storage: IStorageAdapter): void {
  router.get('/summary', async (req, res) => {
    const query = summaryQuerySchema.parse(req.query);
    const summary = await storage.getDashboardSummary(query.hours);
    res.json(summary);
  });
}
