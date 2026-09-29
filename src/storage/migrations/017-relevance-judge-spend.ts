import type { Driver } from '../driver.js';

/*
 * What the relevance judge spent, per tenant per UTC day.
 *
 * The judge calls a provider on the user's key, and its daily budget
 * (IRIS_RELEVANCE_JUDGE_DAILY_BUDGET_USD) must hold across a restart and
 * across every process on one database — the server, a second server, a
 * CLI ingest — or it is a per-process hope rather than a limit. So the
 * balance lives here, beside the traces it was spent on. Money is kept in
 * whole micro-dollars: a day's total is a sum of thousands of fractions of
 * a cent, and an INTEGER column adds them exactly.
 *
 * Holds no trace content: a tenant id, a date and three counters.
 */
export const id = '017-relevance-judge-spend';

export function up(db: Driver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relevance_judge_spend (
      tenant_id TEXT NOT NULL,
      day TEXT NOT NULL,
      spent_micro_usd INTEGER NOT NULL DEFAULT 0,
      calls INTEGER NOT NULL DEFAULT 0,
      refused INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, day)
    );
  `);
}
