/*
 * The relevance judge's spend ledger on SQLite (migration 017).
 *
 * Each operation is ONE statement, so it is atomic on its own: the
 * reservation adds the call's worst case only if the day's total stays
 * within the budget, in the same UPDATE that checks it. Two processes on
 * one database (a server and a hook-driven CLI ingest) therefore cannot
 * both be admitted into the last dollar — SQLite's write lock serialises
 * the two UPDATEs, and the second sees the first's total.
 *
 * The self-test reads a day's row through this class over its own
 * connection, so the SQL lives here once.
 */
import type { Driver } from './driver.js';
import type { DaySpend, JudgeSpendLedger } from '../eval/llm-judge/budget.js';
import { TenantContextRequiredError, type TenantId } from '../types/tenant.js';

/** The same default-deny every storage method applies: an empty tenant is an error, never "every tenant". */
function assertTenant(tenantId: TenantId): void {
  if (typeof tenantId !== 'string' || tenantId.length === 0) throw new TenantContextRequiredError('relevance judge spend');
}

export class SqliteJudgeSpendLedger implements JudgeSpendLedger {
  constructor(private readonly db: Driver) {}

  reserve(tenantId: TenantId, day: string, microUsd: number, limitMicroUsd: number): boolean {
    assertTenant(tenantId);
    this.db.prepare('INSERT OR IGNORE INTO relevance_judge_spend (tenant_id, day) VALUES (?, ?)').run(tenantId, day);
    const admitted = this.db
      .prepare('UPDATE relevance_judge_spend SET spent_micro_usd = spent_micro_usd + ? WHERE tenant_id = ? AND day = ? AND spent_micro_usd + ? <= ?')
      .run(microUsd, tenantId, day, microUsd, limitMicroUsd);
    if (Number(admitted.changes) > 0) return true;
    this.db.prepare('UPDATE relevance_judge_spend SET refused = refused + 1 WHERE tenant_id = ? AND day = ?').run(tenantId, day);
    return false;
  }

  settle(tenantId: TenantId, day: string, deltaMicroUsd: number, called: boolean): void {
    assertTenant(tenantId);
    this.db
      .prepare('UPDATE relevance_judge_spend SET spent_micro_usd = MAX(0, spent_micro_usd + ?), calls = calls + ? WHERE tenant_id = ? AND day = ?')
      .run(deltaMicroUsd, called ? 1 : 0, tenantId, day);
  }

  read(tenantId: TenantId, day: string): DaySpend {
    assertTenant(tenantId);
    const row = this.db
      .prepare('SELECT spent_micro_usd, calls, refused FROM relevance_judge_spend WHERE tenant_id = ? AND day = ?')
      .get(tenantId, day) as { spent_micro_usd: number | bigint; calls: number | bigint; refused: number | bigint } | undefined;
    if (!row) return { spentMicroUsd: 0, calls: 0, refused: 0 };
    return { spentMicroUsd: Number(row.spent_micro_usd), calls: Number(row.calls), refused: Number(row.refused) };
  }
}
