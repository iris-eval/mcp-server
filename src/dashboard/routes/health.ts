import { Router } from 'express';
import type { IStorageAdapter } from '../../types/query.js';
import type { CustomRuleStore } from '../../custom-rule-store.js';
import { buildHealth } from '../../health.js';

export interface HealthOptions {
  /** `demo` when serving the disposable demo database. */
  mode?: 'real' | 'demo';
  /** The deployed custom-rules store, for `checks.rules_store`. */
  customRuleStore?: CustomRuleStore;
}

/*
 * GET /health — the one health contract, on the dashboard port
 * (0.15.0). The answer is built by src/health.ts; the MCP transport's /health
 * calls the same function, so the two ports cannot drift. Mounted by
 * server.ts AHEAD of the rate limiters and the session layer: it carries
 * no trace content and a probe must never be told to slow down.
 */
export function registerHealthRoutes(router: Router, storage?: IStorageAdapter, version?: string, options?: HealthOptions): void {
  router.get('/health', async (_req, res) => {
    const { status, body } = await buildHealth({ storage, version, mode: options?.mode, customRuleStore: options?.customRuleStore });
    res.status(status).json(body);
  });
}
