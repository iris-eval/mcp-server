import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import type { Trace } from '../../../src/types/trace.js';
import type { EvalResult } from '../../../src/types/eval.js';

/*
 * eval_results.created_at silently dropped rows from every time window.
 *
 * The INSERT never set the column, so SQLite's DEFAULT datetime('now')
 * stored "2026-08-09 15:00:00" — space separator, no ms, no Z. Every
 * period query compares that against a JS toISOString() boundary
 * ("2026-08-09T15:00:00.000Z") with plain string comparison, and ' ' (0x20)
 * sorts before 'T' (0x54). So any eval whose CALENDAR DATE equalled the
 * boundary's date fell outside the window: a 20-hour-old eval disappeared
 * from "last 24h", and at 01:00 UTC that view showed only what had happened
 * since midnight. Traces were fine — log_trace writes a real ISO string —
 * so it looked like "evals go missing but traces don't".
 */

let tmpDir: string;
let dbPath: string;
let adapter: SqliteAdapter;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'iris-createdat-'));
  dbPath = join(tmpDir, 'iris.db');
  adapter = new SqliteAdapter(dbPath);
  await adapter.initialize();
});

afterEach(async () => {
  await adapter.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeTrace(id: string, hoursAgo: number): Trace {
  return {
    trace_id: id,
    agent_name: 'test-agent',
    framework: 'mcp',
    input: 'in',
    output: 'out',
    cost_usd: 0.001,
    latency_ms: 100,
    timestamp: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
  };
}

function makeEval(id: string, traceId: string): EvalResult {
  return {
    id,
    trace_id: traceId,
    eval_type: 'completeness',
    output_text: 'out',
    score: 0.9,
    passed: true,
    rule_results: [],
    suggestions: [],
  };
}

describe('created_at is stored as ISO-8601', () => {
  it('writes an ISO timestamp, not SQLite datetime() format', async () => {
    await adapter.insertTrace(LOCAL_TENANT, makeTrace('t1', 0));
    await adapter.insertEvalResult(LOCAL_TENANT, makeEval('e1', 't1'));

    const raw = new Database(dbPath);
    try {
      const row = raw.prepare('SELECT created_at FROM eval_results WHERE id = ?').get('e1') as {
        created_at: string;
      };
      expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(row.created_at).not.toContain(' ');
    } finally {
      raw.close();
    }
  });

  it('counts a 20-hour-old eval inside the 24h window', async () => {
    /*
     * The exact bug. 20h < 24h, so this row belongs in the window; under
     * the old format it was excluded whenever the boundary landed on the
     * same calendar date, which is most of the day.
     */
    await adapter.insertTrace(LOCAL_TENANT, makeTrace('t-old', 20));
    await adapter.insertEvalResult(LOCAL_TENANT, makeEval('e-old', 't-old'));

    const raw = new Database(dbPath);
    try {
      raw
        .prepare('UPDATE eval_results SET created_at = ? WHERE id = ?')
        .run(new Date(Date.now() - 20 * 3_600_000).toISOString(), 'e-old');
    } finally {
      raw.close();
    }

    const stats = await adapter.getEvalStats(LOCAL_TENANT, '24h');
    expect(stats.totalEvals).toBe(1);
  });

  it('still excludes an eval genuinely older than the window', async () => {
    await adapter.insertTrace(LOCAL_TENANT, makeTrace('t-ancient', 30));
    await adapter.insertEvalResult(LOCAL_TENANT, makeEval('e-ancient', 't-ancient'));

    const raw = new Database(dbPath);
    try {
      raw
        .prepare('UPDATE eval_results SET created_at = ? WHERE id = ?')
        .run(new Date(Date.now() - 30 * 3_600_000).toISOString(), 'e-ancient');
    } finally {
      raw.close();
    }

    const stats = await adapter.getEvalStats(LOCAL_TENANT, '24h');
    expect(stats.totalEvals).toBe(0);
  });
});

describe('migration 005 — legacy rows', () => {
  it('normalizes rows already stored in SQLite datetime() format', async () => {
    await adapter.insertTrace(LOCAL_TENANT, makeTrace('t-legacy', 20));
    await adapter.insertEvalResult(LOCAL_TENANT, makeEval('e-legacy', 't-legacy'));

    // Rewrite to the pre-fix shape, then re-run migrations the way a real
    // upgrade does: same file, fresh adapter.
    const raw = new Database(dbPath);
    try {
      raw.prepare("UPDATE eval_results SET created_at = datetime('now', '-20 hours')").run();
      raw.prepare('DELETE FROM _iris_migrations WHERE id = ?').run('005-normalize-created-at');
      const before = raw.prepare('SELECT created_at FROM eval_results').get() as {
        created_at: string;
      };
      expect(before.created_at).toContain(' '); // legacy shape confirmed
    } finally {
      raw.close();
    }

    const upgraded = new SqliteAdapter(dbPath);
    await upgraded.initialize();
    try {
      const stats = await upgraded.getEvalStats(LOCAL_TENANT, '24h');
      expect(stats.totalEvals).toBe(1); // was 0 before the migration
    } finally {
      await upgraded.close();
    }
  });
});
