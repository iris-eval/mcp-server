import { Router } from 'express';
import type { IStorageAdapter } from '../../types/query.js';

export function registerFilterRoutes(router: Router, storage: IStorageAdapter): void {
  router.get('/filters', async (_req, res) => {
    const [agentNames, frameworks] = await Promise.all([
      storage.getDistinctValues('agent_name'),
      storage.getDistinctValues('framework'),
    ]);
    res.json({ agent_names: agentNames, frameworks });
  });
}
