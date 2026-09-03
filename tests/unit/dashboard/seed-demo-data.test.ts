/*
 * seed-demo-data — the data layer behind `iris-mcp --demo`.
 *
 * The contract under test:
 *   1. Seeding produces a real database with the click-worthy failures
 *      (PII, injection, failed judge score) actually present.
 *   2. Seeding is idempotent — a second run adds nothing.
 *   3. The real store is NEVER touched. Verified by hashing the real
 *      files byte-for-byte before and after a seed, not by trusting the
 *      code to have used the right path (the e2e suite once wiped a real
 *      audit.log while green — see feedback in tests/setup/iris-home.ts).
 *   4. clearDemoData removes the whole demo surface and nothing else.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import {
  seedDemoData,
  clearDemoData,
  demoDbPath,
  demoPreferencesPath,
  demoCustomRulesPath,
  demoAuditLogPath,
} from '../../../src/dashboard/seed-demo-data.js';

// The vitest global setup points IRIS_HOME at a suite-wide scratch dir;
// each test here gets its own so clearDemoData cannot cross-talk.
const SUITE_IRIS_HOME = process.env.IRIS_HOME;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'iris-demo-seed-test-'));
  process.env.IRIS_HOME = home;
});

afterEach(() => {
  process.env.IRIS_HOME = SUITE_IRIS_HOME;
  rmSync(home, { recursive: true, force: true });
});

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('demo path helpers', () => {
  it('resolve under IRIS_HOME at call time', () => {
    expect(demoDbPath()).toBe(join(home, 'demo.db'));
    expect(demoPreferencesPath()).toBe(join(home, 'demo-preferences.json'));
    expect(demoCustomRulesPath()).toBe(join(home, 'demo-custom-rules.json'));
    expect(demoAuditLogPath()).toBe(join(home, 'demo-audit.log'));

    const flipped = join(home, 'elsewhere');
    process.env.IRIS_HOME = flipped;
    expect(demoDbPath()).toBe(join(flipped, 'demo.db'));
  });

  it('demo.db is never the real default database file', () => {
    expect(demoDbPath()).not.toBe(join(home, 'iris.db'));
  });
});

describe('seedDemoData', () => {
  it('seeds traces, spans, and evals — including the click-worthy failures', async () => {
    const summary = await seedDemoData({ count: 40 });

    expect(summary.alreadySeeded).toBe(false);
    expect(summary.dbPath).toBe(join(home, 'demo.db'));
    expect(existsSync(summary.dbPath)).toBe(true);
    expect(summary.traceCount).toBeGreaterThanOrEqual(40);
    expect(summary.spanCount).toBeGreaterThan(summary.traceCount);
    expect(summary.evalCount).toBe(summary.traceCount);

    // The guaranteed failures the banner promises must actually exist.
    expect(summary.piiDetectionCount).toBeGreaterThanOrEqual(2);
    expect(summary.injectionDetectionCount).toBeGreaterThanOrEqual(1);
    expect(summary.hallucinationDetectionCount).toBeGreaterThanOrEqual(1);
    expect(summary.costViolationCount).toBeGreaterThanOrEqual(2);
    expect(summary.judgeFailureCount).toBeGreaterThanOrEqual(2);

    // Verify through the storage adapter — the same read path the
    // dashboard uses — rather than trusting the summary arithmetic.
    const adapter = new SqliteAdapter(summary.dbPath);
    await adapter.initialize();
    try {
      const traces = await adapter.queryTraces(LOCAL_TENANT, { limit: 1 });
      expect(traces.total).toBe(summary.traceCount);

      const failed = await adapter.queryEvalResults(LOCAL_TENANT, { passed: false, limit: 500 });
      const failedRules = failed.results.flatMap((e) => e.rule_results.filter((r) => !r.passed));
      expect(failedRules.some((r) => r.ruleName === 'no_pii')).toBe(true);
      expect(failedRules.some((r) => r.ruleName === 'no_injection_patterns')).toBe(true);
      expect(failedRules.some((r) => r.ruleName.startsWith('llm_judge:'))).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it('never dates a demo trace in the future', async () => {
    // The last seeded day is today and the hour is drawn from the whole
    // day, so without the clamp a morning seed carried traces stamped for
    // tonight — rendered as "just now" and re-counted as "new" forever.
    const seededAt = Date.now();
    const summary = await seedDemoData({ count: 60 });
    const adapter = new SqliteAdapter(summary.dbPath);
    await adapter.initialize();
    try {
      const { traces } = await adapter.queryTraces(LOCAL_TENANT, {
        limit: 1000,
        sort_by: 'timestamp',
        sort_order: 'desc',
      });
      expect(traces.length).toBe(summary.traceCount);
      const future = traces.filter((t) => new Date(t.timestamp).getTime() > seededAt + 1000);
      expect(future.map((t) => t.timestamp)).toEqual([]);
      // Today's traces still exist — the clamp moves them, it does not drop them.
      const today = traces.filter((t) => seededAt - new Date(t.timestamp).getTime() < 24 * 3_600_000);
      expect(today.length).toBeGreaterThan(0);
    } finally {
      await adapter.close();
    }
  });

  it('is idempotent — a second seed leaves the database untouched', async () => {
    const first = await seedDemoData({ count: 30 });
    expect(first.alreadySeeded).toBe(false);

    const second = await seedDemoData({ count: 30 });
    expect(second.alreadySeeded).toBe(true);
    expect(second.traceCount).toBe(first.traceCount);

    const adapter = new SqliteAdapter(first.dbPath);
    await adapter.initialize();
    try {
      const traces = await adapter.queryTraces(LOCAL_TENANT, { limit: 1 });
      expect(traces.total).toBe(first.traceCount);
    } finally {
      await adapter.close();
    }
  });

  it('never touches the real store — byte-identical before and after', async () => {
    // Build a REAL store the way the product does, with a trace in it.
    const realDbPath = join(home, 'iris.db');
    const realStore = new SqliteAdapter(realDbPath);
    await realStore.initialize();
    await realStore.insertTrace(LOCAL_TENANT, {
      trace_id: 'real-trace-1',
      agent_name: 'my-real-agent',
      input: 'a real question',
      output: 'a real answer',
      timestamp: new Date().toISOString(),
    });
    await realStore.close();

    // And the real per-user sidecar files.
    const realFiles: Record<string, string> = {
      [realDbPath]: '',
      [join(home, 'custom-rules.json')]: JSON.stringify({ version: 1, rules: [] }),
      [join(home, 'audit.log')]: '{"ts":"2026-01-01T00:00:00.000Z","action":"rule.deploy"}\n',
      [join(home, 'preferences.json')]: JSON.stringify({ autoLaunch: true }),
    };
    for (const [path, content] of Object.entries(realFiles)) {
      if (content) writeFileSync(path, content, 'utf-8');
    }

    const hashesBefore = Object.keys(realFiles).map(sha256);

    await seedDemoData({ count: 30 });

    const hashesAfter = Object.keys(realFiles).map(sha256);
    expect(hashesAfter).toEqual(hashesBefore);

    // And the demo db exists as its own separate file.
    expect(existsSync(join(home, 'demo.db'))).toBe(true);
  });
});

describe('clearDemoData', () => {
  it('removes the demo database and sidecar files, and reports what it removed', async () => {
    const { dbPath } = await seedDemoData({ count: 30 });
    writeFileSync(demoPreferencesPath(), JSON.stringify({ autoLaunch: false }), 'utf-8');
    writeFileSync(demoCustomRulesPath(), JSON.stringify({ version: 1, rules: [] }), 'utf-8');

    // A real store sitting next to the demo files must survive the clear.
    const realDbPath = join(home, 'iris.db');
    writeFileSync(realDbPath, 'not-actually-sqlite-but-must-survive', 'utf-8');

    const { removed } = clearDemoData();

    expect(removed).toContain(dbPath);
    expect(removed).toContain(demoPreferencesPath());
    expect(removed).toContain(demoCustomRulesPath());
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(existsSync(demoPreferencesPath())).toBe(false);
    expect(existsSync(demoCustomRulesPath())).toBe(false);
    expect(existsSync(realDbPath)).toBe(true);
  });

  it('is a no-op when there is nothing to remove', () => {
    const { removed } = clearDemoData();
    expect(removed).toEqual([]);
  });
});
