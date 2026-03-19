import { Router } from 'express';
import type { IStorageAdapter } from '../../types/query.js';
import { evalQuerySchema, exportEvalQuerySchema } from '../validation.js';
import { toCsv } from './csv.js';

export function registerEvaluationRoutes(router: Router, storage: IStorageAdapter): void {
  router.get('/evaluations/export', async (req, res) => {
    const query = exportEvalQuerySchema.parse(req.query);
    const result = await storage.queryEvalResults({
      eval_type: query.eval_type,
      passed: query.passed,
      since: query.since,
      until: query.until,
      limit: query.limit,
      offset: 0,
    });

    const filename = `evaluations-export.${query.format}`;
    if (query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(toCsv(
        ['id', 'trace_id', 'eval_type', 'passed', 'score', 'output_text', 'created_at'],
        result.results.map((r) => [
          r.id,
          r.trace_id ?? '',
          r.eval_type,
          r.passed,
          r.score,
          r.output_text,
          r.created_at ?? '',
        ]),
      ));
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.json(result.results);
    }
  });

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
