/*
 * One health contract for both ports.
 *
 * Until 0.15.0 the dashboard's `/api/v1/health` reported status, version,
 * uptime, a trace count and a storage word, while the MCP transport's
 * `/health` answered `{ status, server, timestamp }` — and the API reference
 * said they were "the same contract". They were not. This module is the
 * one place the answer is built; both routes call it, so the two ports
 * cannot drift again, and a container `HEALTHCHECK`, a load balancer and a
 * human read one shape.
 *
 * What the checks mean:
 *   storage      the database answers a COUNT (the all-time trace count)
 *   rules_store  the deployed custom-rules file reads and parses
 *   migrations   every migration this build knows is applied; the numbers
 *                are how many, so an operator can see a schema is behind
 *                before a query fails on a missing column
 *   driver       which SQLite driver opened the file (arc 8, R-0 adds the
 *                Node built-in as a fallback; the word is the seam)
 *
 * `status` is `ok` only when every check that could run is `ok`; anything
 * else is `degraded` with HTTP 503, so a probe that only reads the status
 * code gets the right answer. The older fields (`trace_count`, `storage`,
 * `judge`, `mode`) stay: the dashboard header and the UAT read them.
 */
import type { IStorageAdapter } from './types/query.js';
import type { CustomRuleStore } from './custom-rule-store.js';
import { LOCAL_TENANT } from './types/tenant.js';
import { judgeState } from './judge-enablement.js';

const startTime = Date.now();

export type CheckState = 'ok' | 'fail' | 'absent';

export interface HealthReport {
  status: 'ok' | 'degraded';
  version: string;
  uptime_seconds: number;
  /** The SQLite driver behind `storage`, or null when no storage is attached. */
  driver: string | null;
  checks: {
    storage: CheckState;
    rules_store: CheckState;
    migrations: { status: CheckState; applied: number; known: number };
  };
  /** All-time trace count; present when storage answered. */
  trace_count?: number;
  /** The word the pre-0.15.0 contract used; kept for readers of it. */
  storage?: 'connected' | 'disconnected';
  judge: { enabled: boolean; provider: string | null };
  mode: 'real' | 'demo';
}

export interface HealthDeps {
  storage?: IStorageAdapter;
  customRuleStore?: CustomRuleStore;
  version?: string;
  /** `demo` when serving the disposable demo database. */
  mode?: 'real' | 'demo';
}

/** The report and the HTTP status it should travel with (200 ok, 503 degraded). */
export async function buildHealth(deps: HealthDeps): Promise<{ status: number; body: HealthReport }> {
  const uptime_seconds = Math.floor((Date.now() - startTime) / 1000);
  /*
   * The judge state, provider name only — never the key. Read per request
   * rather than at boot so a test (or an operator) that sets the variable
   * in this process sees it here.
   */
  const judge = judgeState();
  const body: HealthReport = {
    status: 'ok',
    version: deps.version ?? 'unknown',
    uptime_seconds,
    driver: deps.storage?.driver ?? null,
    checks: {
      storage: 'absent',
      rules_store: 'absent',
      migrations: { status: 'absent', applied: 0, known: 0 },
    },
    judge: { enabled: judge.enabled, provider: judge.provider },
    mode: deps.mode ?? 'real',
  };

  if (deps.storage) {
    /*
     * Health probes use LOCAL_TENANT directly — the endpoint is pre-tenant-
     * resolution (it answers unauthenticated callers) and reports server-
     * level facts. This is the ONE place storage is called with an explicit
     * LOCAL_TENANT rather than a resolved tenantId; deliberate, documented
     * here so it stays the only exception.
     *
     * trace_count is ALL-TIME (#373 item 1): queryTraces' `total` is the
     * unfiltered COUNT(*) for the tenant; limit 1 keeps the row fetch
     * negligible.
     */
    try {
      const { total } = await deps.storage.queryTraces(LOCAL_TENANT, { limit: 1, offset: 0 });
      body.trace_count = total;
      body.storage = 'connected';
      body.checks.storage = 'ok';
    } catch {
      body.storage = 'disconnected';
      body.checks.storage = 'fail';
    }
    try {
      const m = await deps.storage.migrations();
      body.checks.migrations = { status: m.pending.length === 0 ? 'ok' : 'fail', applied: m.applied, known: m.known };
    } catch {
      body.checks.migrations = { status: 'fail', applied: 0, known: 0 };
    }
  }

  if (deps.customRuleStore) {
    try {
      deps.customRuleStore.list(LOCAL_TENANT);
      body.checks.rules_store = 'ok';
    } catch {
      body.checks.rules_store = 'fail';
    }
  }

  const failed =
    body.checks.storage === 'fail' || body.checks.rules_store === 'fail' || body.checks.migrations.status === 'fail';
  body.status = failed ? 'degraded' : 'ok';
  return { status: failed ? 503 : 200, body };
}
