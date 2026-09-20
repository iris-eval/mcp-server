/*
 * Playwright globalSetup — prepares a deterministic test database.
 *
 * Runs ONCE per `npx playwright test` invocation, in parallel with
 * Playwright's webServer starting up. Strategy:
 *   1. Poll /api/v1/health until the iris-mcp webServer is ready
 *      (this guarantees migrations have run).
 *   2. Open a second SqliteAdapter connection against the same DB file
 *      (SQLite WAL supports concurrent readers + one writer).
 *   3. Delete any existing e2e seed rows so reruns are idempotent.
 *   4. Insert 20 deterministic traces, 20 evals, 1 audit entry.
 *
 * Scope: LOCAL_TENANT only. Multi-tenant isolation is covered by the
 * unit test at tests/unit/storage/sqlite-adapter.test.ts.
 */
import { mkdirSync, appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import type { Trace } from '../../src/types/trace.js';
import type { EvalResult } from '../../src/types/eval.js';
import { E2E_BASE_URL, E2E_DB_DIR, E2E_DB_PATH } from './_constants.js';

const AGENTS = ['research-synthesizer', 'content-drafter', 'data-extractor', 'code-reviewer'];
/** The seeded $1.33 trace (D-4): tests/e2e/verdict.spec.ts opens /traces/e2e-trace-0019. */
export const COST_CASE_INDEX = 19;

function makeTrace(i: number): Trace {
  const agent = AGENTS[i % AGENTS.length];
  // Spread 20 traces across ~7 days so Health 30d trend + Drift 7d
  // stacked bar both have multi-bucket data to render.
  const SPREAD_HOURS = (7 * 24) / 20; // = 8.4h between traces
  const hoursAgo = i * SPREAD_HOURS;
  return {
    trace_id: `e2e-trace-${String(i).padStart(4, '0')}`,
    agent_name: agent,
    framework: 'mcp',
    input: `Test prompt ${i} for ${agent}`,
    output: `Test output ${i} containing relevant information for the synthesis task.`,
    cost_usd: 0.0003 + (i % 5) * 0.0001,
    latency_ms: 120 + (i % 7) * 15,
    timestamp: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
  };
}

function makeEval(trace: Trace, index: number): EvalResult {
  if (index === COST_CASE_INDEX) {
    /*
     * The plan's own case (arc 7, D-4): a $1.33 trace at defaults.
     * cost_under_threshold fails against the shipped $0.10 and does not
     * decide (the number is Iris's, not the deployment's); the verdict
     * passes and interpretations[] says why. The verdict, coverage and
     * interpretations are composed on read from provenance.composer, the
     * way a stored row is — nothing here fabricates them.
     */
    return {
      id: `e2e-eval-${String(index).padStart(4, '0')}`,
      trace_id: trace.trace_id,
      eval_type: 'cost',
      output_text: trace.output ?? '',
      score: 0.5,
      passed: true,
      rule_results: [
        {
          ruleName: 'cost_under_threshold',
          passed: false,
          score: 0,
          message: 'cost $1.33 exceeds threshold $0.10',
          kind: 'policy',
          origin: 'built-in',
          question: 'within_budget',
          saw: ['cost_usd'],
          evidence: [{ type: 'count', stat: 'cost', unit: 'usd', value: 1.33, threshold: 0.1, thresholdSource: 'default' }],
          uncertainty: { basis: 'policy' },
        },
        {
          ruleName: 'min_output_length',
          passed: true,
          score: 1,
          message: 'OK',
          kind: 'measurement',
          origin: 'built-in',
          question: 'complete',
          saw: ['output'],
          value: { stat: 'length', unit: 'chars', value: (trace.output ?? '').length },
          uncertainty: { basis: 'policy' },
        },
      ],
      suggestions: [],
      provenance: {
        irisVersion: '0.13.0',
        rulesetHash: 'e2e-seed',
        configHash: 'e2e-seed',
        thresholds: { default: 0.7 },
        corpusVersion: 'e2e-seed',
        composer: { defaultsGate: false, falsePassCost: 1, onCriticalSkipped: 'unknown' },
        judgedAt: trace.timestamp ?? new Date().toISOString(),
      },
    };
  }
  const passed = index % 7 !== 0; // ~85% pass rate
  return {
    id: `e2e-eval-${String(index).padStart(4, '0')}`,
    trace_id: trace.trace_id,
    eval_type: 'completeness',
    output_text: trace.output ?? '',
    score: passed ? 0.92 : 0.45,
    passed,
    rule_results: [
      {
        ruleName: 'min_output_length',
        passed,
        score: passed ? 1 : 0,
        message: passed ? 'OK' : 'output too short',
      },
    ],
    suggestions: passed ? [] : ['Expand the response'],
  };
}

async function waitForHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`webServer health never returned OK at ${url} within ${timeoutMs}ms`);
}

export default async function globalSetup(): Promise<void> {
  // 1. Wait for webServer to finish initialization (migrations, etc.).
  await waitForHealth(`${E2E_BASE_URL}/api/v1/health`);

  // 2. Open a second connection against the same DB. SqliteAdapter's
  //    initialize() is idempotent — migrations that already ran are
  //    skipped via the _iris_migrations table.
  const adapter = new SqliteAdapter(E2E_DB_PATH);
  await adapter.initialize();

  try {
    // 3. Clear existing test-seed rows from all three data tables.
    //    deleteTracesOlderThan() alone doesn't cascade to eval_results
    //    (FK is SET NULL, not CASCADE) so we drop directly via a raw
    //    connection. Scope to LOCAL_TENANT so we never affect other
    //    tenants even if the test DB somehow has them.
    const raw = new Database(E2E_DB_PATH);
    try {
      raw.prepare('DELETE FROM eval_results WHERE tenant_id = ?').run(LOCAL_TENANT);
      raw.prepare('DELETE FROM spans WHERE tenant_id = ?').run(LOCAL_TENANT);
      raw.prepare('DELETE FROM traces WHERE tenant_id = ?').run(LOCAL_TENANT);
      // Labels name evaluations by id (D-8); a label from an earlier run
      // would otherwise count against this run's seeded rows.
      raw.prepare('DELETE FROM verdict_labels WHERE tenant_id = ?').run(LOCAL_TENANT);

      // 4. Insert via the adapter (tenant-safe + typed) then backfill
      //    eval_results.created_at so trend queries return multi-bucket
      //    data. The adapter's INSERT uses SQLite's datetime('now')
      //    default, which would collapse all rows into one trend bucket
      //    even though trace timestamps span 7 days.
      for (let i = 0; i < 20; i++) {
        const trace = makeTrace(i);
        if (i === COST_CASE_INDEX) trace.cost_usd = 1.33;
        // Two runs over the same ten cases (D-5): traces 0–9 are the
        // baseline, 10–19 the candidate; case-k is trace k and trace k+10.
        // The baseline fails case-0 and case-7 (i % 7 === 0), the candidate
        // fails case-4 (i = 14), so the pair is comparable, paired, and not
        // distinguishable at n = 10 — and case-0 is flaky across runs.
        trace.run_id = i < 10 ? 'baseline' : 'candidate';
        trace.case_key = `case-${i % 10}`;
        await adapter.insertTrace(LOCAL_TENANT, trace);
        const evalResult = makeEval(trace, i);
        evalResult.run_id = trace.run_id;
        await adapter.insertEvalResult(LOCAL_TENANT, evalResult);
        raw
          .prepare('UPDATE eval_results SET created_at = ? WHERE id = ?')
          .run(trace.timestamp, evalResult.id);
      }
    } finally {
      raw.close();
    }
  } finally {
    await adapter.close();
  }

  // 5. Reset preferences via the live API so the Welcome Tour doesn't
  //    auto-open during tests (it's an aria-modal dialog that blocks
  //    pointer events on every element behind it).
  //
  //    IMPORTANT: a raw writeFileSync to ~/.iris/preferences.json does
  //    NOT work. The iris-mcp server loads preferences into memory once
  //    on boot (src/preferences.ts createPreferenceStore), and only
  //    PATCH /api/v1/preferences updates both the memory cache and the
  //    disk file. A file write after server boot is invisible to GET
  //    requests from the dashboard — the tour then shows and blocks all
  //    click-based tests.
  const patchRes = await fetch(`${E2E_BASE_URL}/api/v1/preferences`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      autoLaunch: false,
      dismissedTours: ['tour-welcome'],
      archivedMoments: [],
      momentFilters: {},
      density: 'compact',
      sidebarCollapsed: false,
      // Reset the notifications cursor to the epoch so the seeded audit
      // entry (4 hours ago) always registers as unread at test start.
      // Without this, prior test runs leave a more-recent lastSeen and
      // the unread-badge test falsely passes/fails depending on order.
      notificationsLastSeen: '1970-01-01T00:00:00.000Z',
    }),
  });
  if (!patchRes.ok) {
    throw new Error(
      `globalSetup preferences PATCH failed: ${patchRes.status} ${patchRes.statusText}`,
    );
  }

  // 6. Seed one audit entry so PassRateAreaChart renders an annotation.
  //    The webServer runs with IRIS_HOME=E2E_DB_DIR (playwright.config),
  //    so its audit log lives in the temp dir — resetting it here touches
  //    ONLY test state. (Before IRIS_HOME existed this line wiped the
  //    user's real ~/.iris/audit.log on every run.)
  const auditLog = join(E2E_DB_DIR, 'audit.log');
  const auditDir = dirname(auditLog);
  if (!existsSync(auditDir)) mkdirSync(auditDir, { recursive: true });
  // Reset — every e2e run starts with a single deterministic entry.
  writeFileSync(auditLog, '');
  const auditEntry = {
    ts: new Date(Date.now() - 4 * 3_600_000).toISOString(),
    tenantId: 'local',
    action: 'rule.deploy',
    user: 'local',
    ruleId: 'e2e-seeded-rule',
    ruleName: 'e2e-seed-rule',
    details: { severity: 'medium' },
  };
  appendFileSync(auditLog, JSON.stringify(auditEntry) + '\n');
}
