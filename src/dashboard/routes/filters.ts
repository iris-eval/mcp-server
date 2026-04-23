import { Router } from 'express';
import type { IStorageAdapter } from '../../types/query.js';
import { requireTenant } from '../../middleware/tenant.js';

export function registerFilterRoutes(router: Router, storage: IStorageAdapter): void {
  router.get('/filters', async (req, res) => {
    const tenantId = requireTenant(req);
    const [agentNames, frameworks] = await Promise.all([
      storage.getDistinctValues(tenantId, 'agent_name'),
      storage.getDistinctValues(tenantId, 'framework'),
    ]);
    res.json({ agent_names: agentNames, frameworks });
  });
}
