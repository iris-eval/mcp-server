import { Router } from 'express';
import type { IStorageAdapter } from '../../types/query.js';
import { requireTenant } from '../../middleware/tenant.js';
import { evalQuerySchema, evalExportQuerySchema } from '../validation.js';
import { sendExport } from '../export-response.js';
import { evalEncoder } from '../../export/format.js';

export function registerEvaluationRoutes(router: Router, storage: IStorageAdapter): void {
  // Every evaluation the list's filters admit, as CSV or JSON Lines, streamed (#4).
  router.get('/evaluations/export', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const query = evalExportQuerySchema.parse(req.query);
      const batches = storage.exportEvalResults(tenantId, {
        eval_type: query.eval_type,
        passed: query.passed,
        since: query.since,
        until: query.until,
      });
      await sendExport(res, 'evaluations', query.format, evalEncoder(query.format), batches);
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid query parameters', details: (err as unknown as { issues: unknown }).issues });
        return;
      }
      throw err;
    }
  });

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
