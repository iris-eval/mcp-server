import { Router } from 'express';
import { z } from 'zod';
import { readAuditLog } from '../../audit-log-reader.js';
import type { CustomRuleStore } from '../../custom-rule-store.js';

const QuerySchema = z.object({
  action: z.enum(['rule.deploy', 'rule.delete', 'rule.toggle', 'rule.update']).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export function registerAuditRoutes(router: Router, store?: CustomRuleStore): void {
  router.get('/audit', (req, res) => {
    try {
      const query = QuerySchema.parse(req.query);
      const result = readAuditLog({
        // CustomRuleStore controls the audit file path; defer to it when
        // available so tests + production match the same target.
        filePath: store?.auditPath,
        filter: {
          action: query.action,
          since: query.since,
          search: query.search,
        },
        limit: query.limit,
        offset: query.offset,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid audit query', details: err.issues });
        return;
      }
      throw err;
    }
  });
}
