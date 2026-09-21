/*
 * Datasets over HTTP (arc 8, R-8).
 *
 *   POST /api/v1/datasets          promote case keys into a named dataset —
 *                                  a run's keys (`from_run`), an explicit
 *                                  list (`case_keys`), or cases with the
 *                                  answer the reader expects (`cases`)
 *   GET  /api/v1/datasets          every dataset with its case count
 *   GET  /api/v1/datasets/:id      one dataset by id or label, with its keys
 *
 * A dataset is the reader's answer to "which cases are the gate?":
 * `compare_runs` / `POST /api/v1/compare` take `dataset` and pair only the
 * cases in it; `ingest --fail-on … --dataset` fails a job only on them. No
 * statistic is new — the same tests over a chosen set of cases.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { IStorageAdapter } from '../../types/query.js';
import { requireTenant } from '../../middleware/tenant.js';
import { strictBody } from '../validation.js';
import { DatasetExistsError } from '../../storage/sqlite-adapter.js';

const caseKey = z.string().trim().min(1).max(200);

const createDatasetSchema = strictBody({
  label: z.string().trim().min(1).max(200),
  from_run: z.string().trim().min(1).max(200).optional(),
  case_keys: z.array(caseKey).max(10_000).optional(),
  cases: z.array(z.strictObject({ case_key: caseKey, expected: z.unknown().optional() })).max(10_000).optional(),
});

export function registerDatasetRoutes(router: Router, storage: IStorageAdapter): void {
  router.get('/datasets', async (req, res) => {
    const tenantId = requireTenant(req);
    const datasets = await storage.listDatasets(tenantId);
    res.json({ datasets, count: datasets.length });
  });

  router.get('/datasets/:id', async (req, res) => {
    const tenantId = requireTenant(req);
    const dataset = await storage.getDataset(tenantId, req.params.id);
    if (!dataset) {
      res.status(404).json({ error: 'No dataset has that id or label' });
      return;
    }
    res.json({ dataset });
  });

  router.post('/datasets', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const body = createDatasetSchema.parse(req.body);
      // Union of the three sources; an explicit `cases` entry may carry the expected answer.
      const cases = new Map<string, unknown>();
      if (body.from_run) for (const key of await storage.caseKeysInRun(tenantId, body.from_run)) cases.set(key, null);
      for (const key of body.case_keys ?? []) if (!cases.has(key)) cases.set(key, null);
      for (const c of body.cases ?? []) cases.set(c.case_key, c.expected === undefined ? (cases.get(c.case_key) ?? null) : c.expected);
      if (cases.size === 0) {
        res.status(400).json({
          error: body.from_run
            ? `Run "${body.from_run}" has no traces with a case key, so there is nothing to promote. Pass case_key on log_trace or ingest, or name the keys in case_keys.`
            : 'A dataset needs at least one case key: pass from_run, case_keys, or cases.',
        });
        return;
      }
      const dataset = await storage.createDataset(tenantId, {
        label: body.label,
        cases: [...cases].map(([key, expected]) => ({ caseKey: key, expected })),
      });
      res.status(201).json({ dataset });
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid request body', details: (err as unknown as { issues: unknown }).issues });
        return;
      }
      if (err instanceof DatasetExistsError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });
}
