import { Router } from 'express';
import type { IStorageAdapter } from '../../types/query.js';
import { requireTenant } from '../../middleware/tenant.js';
import { summaryQuerySchema } from '../validation.js';

export function registerSummaryRoutes(router: Router, storage: IStorageAdapter): void {
  router.get('/summary', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const query = summaryQuerySchema.parse(req.query);
      const summary = await storage.getDashboardSummary(tenantId, query.hours);
      res.json(summary);
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid query parameters', details: (err as unknown as { issues: unknown }).issues });
        return;
      }
      throw err;
    }
  });
}
