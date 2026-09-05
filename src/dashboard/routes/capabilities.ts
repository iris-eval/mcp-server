import { Router } from 'express';
import type { Capabilities } from '../../capabilities.js';

/*
 * GET /api/v1/capabilities — the same object iris://capabilities serves,
 * for a caller on the HTTP path (an agent driving Iris through the ingest
 * endpoint, a dashboard, a health probe that wants more than "ok").
 * Provider name only, never a key.
 */
export function registerCapabilitiesRoutes(router: Router, build: () => Capabilities): void {
  router.get('/capabilities', (_req, res) => {
    res.json(build());
  });
}
