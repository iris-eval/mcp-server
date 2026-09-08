/*
 * SqliteAdapter — tenant-enforcing SQLite implementation of IStorageAdapter.
 *
 * Every public method takes a TenantId as its first parameter and uses
 * it in the SQL layer to prevent cross-tenant data leaks. See the
 * 2026-04-23 threat model §5 for the design principles.
 *
 * Discipline:
 *   - Every method first validates tenantId is a non-empty string.
 *     If validation fails, throws TenantContextRequiredError. This is
 *     defense-in-depth — the TenantId type system already prevents
 *     empty strings at compile time, but we verify at runtime too so
 *     any dynamic bypass (e.g. a buggy cast) still fails safe.
 *   - Every INSERT binds tenant_id from the parameter, never from the
 *     payload data.
 *   - Every SELECT includes `WHERE tenant_id = ?` as the first
 *     condition; composite indexes put tenant_id first.
 *   - Aggregate queries (stats, trends) scope to the tenant.
 *   - DELETE operations scope to the tenant — a tenant can only delete
 *     its own data.
 */
import Database from 'better-sqlite3';
import { resolveCaseKey } from '../eval/case-key.js';
import { toolsHash } from '../eval/catalogue.js';
import { ensureOwnerOnly } from '../utils/write-atomic.js';
import type {
  IStorageAdapter,
  DashboardSummary,
  TraceQueryOptions,
  TraceQueryResult,
  EvalStatsPeriod,
  EvalStats,
  AgentFailureLogEntry,
  DriftWindow,
  EvalStatsTrendBucket,
  TrendCohort,
  EvalStatsRuleBreakdown,
  EvalStatsFailure,
} from '../types/query.js';
import type { Trace, Span } from '../types/trace.js';
import type { EvalResult, Provenance, EvalRuleResult, Evidence } from '../types/eval.js';
import { deriveCoverage, deriveCriticalSkipped } from '../eval/verdict.js';
import { compose, interpretations, DEFAULT_COMPOSE } from '../eval/compose.js';
import type { TenantId } from '../types/tenant.js';
import { TenantContextRequiredError } from '../types/tenant.js';
import { runMigrations } from './migrations/index.js';

const ALLOWED_SORT_COLUMNS = new Set(['timestamp', 'latency_ms', 'cost_usd']);
const ALLOWED_SORT_ORDERS = new Set(['asc', 'desc']);

/**
 * Defense-in-depth runtime check. The TypeScript brand prevents most
 * misuse at compile time; this catches any dynamic cast bypass.
 */
function assertTenant(tenantId: TenantId): void {
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new TenantContextRequiredError(
      'SqliteAdapter method invoked without a valid TenantId; refusing to query',
    );
  }
}

export type RedactMode = 'none' | 'critical_spans';
export interface SqliteAdapterOptions {
  /** storage.redact — replace the spans a critical detector flagged in the stored text. */
  redact?: RedactMode;
}
/** What every text field of an erased evaluation reads afterwards. */
export const ERASED_MESSAGE = 'erased with the trace';

/**
 * A run as a reader sees it.
 *
 * Almost every field here is DERIVED from the rows in the run rather than
 * read out of the `runs` table, and that is deliberate. Two sources for one
 * fact is how a registry starts disagreeing with the data it describes: a
 * stored `n` drifts the moment a trace is deleted, and a stored
 * `rulesetHash` is wrong the moment one trace in the run is re-evaluated.
 * The registry therefore stores only what CANNOT be derived — the caller's
 * own label, and the fact that a run was produced by re-evaluating another
 * one — and everything countable is counted at read time.
 */
export interface RunSummaryRow {
  runId: string;
  /** The caller's name for this batch; null when it was never registered. */
  label: string | null;
  /** Set when this run came from re-evaluating another, so a rules change is never read as an agent change. */
  reevaluationOf: string | null;
  traces: number;
  evaluated: number;
  passed: number;
  agentNames: string[];
  engineVersions: string[];
  rulesetHashes: string[];
  startedAt: string | null;
  lastActivityAt: string | null;
}

/** One trace's latest evaluation inside a run — the unit a comparison counts. */
export interface RunResultRow {
  evalId: string;
  traceId: string | null;
  /** What makes this the same question as a row in another run; null when nothing supplied or derived one. */
  caseKey: string | null;
  agentName: string | null;
  passed: boolean;
  /** Rules that fired, for the per-rule breakdown. Skips are not failures. */
  failedRules: string[];
  engineVersion: string | null;
  rulesetHash: string | null;
  configHash: string | null;
  createdAt: string;
  /** How many older evaluations of these traces were collapsed away. */
  supersededInRun?: number;
}

/** One attempt at one case — every attempt, because repetition is what is being measured. */
export interface CaseResultRow {
  evalId: string;
  traceId: string | null;
  caseKey: string | null;
  runId: string | null;
  passed: boolean;
  createdAt: string;
}

export class SqliteAdapter implements IStorageAdapter {
  private db: Database.Database;
  private readonly dbPath: string;

  /** storage.redact — see SqliteAdapterOptions. */
  private readonly redact: RedactMode;

  constructor(dbPath: string, options?: SqliteAdapterOptions) {
    this.dbPath = dbPath;
    this.redact = options?.redact ?? 'none';
    this.db = new Database(dbPath);
  }

  async initialize(): Promise<void> {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    /*
     * secure_delete overwrites freed content with zeros instead of leaving
     * it in place until the page is reused. Without it, a DELETE — the
     * retention sweep, delete_trace, --purge — removed the row from every
     * query while the text stayed byte-for-byte readable in the file with
     * `strings iris.db`. Deletes are rare here (startup sweep, explicit
     * deletes), so the write cost is negligible; the privacy cost of the
     * alternative is the whole point of #372.
     */
    this.db.pragma('secure_delete = ON');
    try {
      runMigrations(this.db);
    } catch (err) {
      // A refused boot (a newer writer, a failed migration) must not leak the handle.
      this.db.close();
      throw err;
    }
    /*
     * iris.db holds agent inputs and outputs verbatim, and a tool that
     * detects PII necessarily stores the PII it found. better-sqlite3
     * creates the file with the process umask (typically 0644 = readable by
     * every local account), and WAL mode creates two sidecars that hold the
     * same data. Narrow all three after the pragmas, since -wal/-shm do not
     * exist until WAL is enabled. No-op on Windows and on :memory:.
     */
    if (this.dbPath !== ':memory:') {
      ensureOwnerOnly(this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`);
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async insertTrace(tenantId: TenantId, trace: Trace): Promise<void> {
    assertTenant(tenantId);
    const insertTraceStmt = this.db.prepare(`
      INSERT INTO traces (tenant_id, trace_id, agent_name, framework, input, output, tool_calls, latency_ms, token_usage, cost_usd, metadata, timestamp, tools, tools_hash, run_id, case_key, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSpanStmt = this.db.prepare(`
      INSERT INTO spans (tenant_id, span_id, trace_id, parent_span_id, name, kind, status_code, status_message, start_time, end_time, attributes, events)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertAll = this.db.transaction((t: Trace) => {
      insertTraceStmt.run(
        tenantId,
        t.trace_id,
        t.agent_name,
        t.framework ?? null,
        t.input ?? null,
        t.output ?? null,
        t.tool_calls ? JSON.stringify(t.tool_calls) : null,
        t.latency_ms ?? null,
        t.token_usage ? JSON.stringify(t.token_usage) : null,
        t.cost_usd ?? null,
        t.metadata ? JSON.stringify(t.metadata) : null,
        t.timestamp,
        t.tools ? JSON.stringify(t.tools) : null,
        // Derived on write so "same toolset?" is an indexed question rather
        // than a parse of every stored blob. Hashes only what a rule reads.
        toolsHash(t.tools) ?? null,
        t.run_id ?? null,
        /*
         * Derived on write when the caller sent none, so pairing works for
         * a caller who never heard of case keys. Storing it (rather than
         * deriving on read) is what lets a caller who DOES know its case
         * identity overrule the hash — see src/eval/case-key.ts.
         */
        resolveCaseKey(t.case_key, t.input),
        t.source ?? null,
      );

      if (t.spans) {
        for (const span of t.spans) {
          insertSpanStmt.run(
            tenantId,
            span.span_id,
            t.trace_id,
            span.parent_span_id ?? null,
            span.name,
            span.kind,
            span.status_code,
            span.status_message ?? null,
            span.start_time,
            span.end_time ?? null,
            span.attributes ? JSON.stringify(span.attributes) : null,
            span.events ? JSON.stringify(span.events) : null,
          );
        }
      }
    });

    insertAll(trace);
  }

  async getTrace(tenantId: TenantId, traceId: string): Promise<Trace | null> {
    assertTenant(tenantId);
    const row = this.db
      .prepare('SELECT * FROM traces WHERE tenant_id = ? AND trace_id = ?')
      .get(tenantId, traceId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToTrace(row);
  }

  async queryTraces(tenantId: TenantId, options: TraceQueryOptions): Promise<TraceQueryResult> {
    assertTenant(tenantId);
    const conditions: string[] = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];
    const filter = options.filter;

    if (filter?.agent_name) {
      conditions.push('agent_name = ?');
      params.push(filter.agent_name);
    }
    if (filter?.framework) {
      conditions.push('framework = ?');
      params.push(filter.framework);
    }
    if (filter?.since) {
      conditions.push('timestamp >= ?');
      params.push(filter.since);
    }
    if (filter?.until) {
      conditions.push('timestamp <= ?');
      params.push(filter.until);
    }
    if (filter?.min_score !== undefined || filter?.max_score !== undefined) {
      /*
       * Both bounds apply to the LATEST eval per trace (created_at DESC,
       * rowid breaking ties within the same millisecond) — the semantics
       * the get_traces description promises. These used to be two
       * INDEPENDENT EXISTS subqueries, so a trace with evals at 0.95 and
       * 0.05 matched min_score=0.4 + max_score=0.6: each bound was
       * satisfied by a different eval even though no single eval — let
       * alone the latest — was in range (#332).
       */
      const scoreBounds: string[] = [];
      if (filter.min_score !== undefined) {
        scoreBounds.push('e.score >= ?');
      }
      if (filter.max_score !== undefined) {
        scoreBounds.push('e.score <= ?');
      }
      conditions.push(
        'EXISTS (SELECT 1 FROM eval_results e WHERE e.rowid = ' +
          '(SELECT e2.rowid FROM eval_results e2 WHERE e2.tenant_id = traces.tenant_id AND e2.trace_id = traces.trace_id ' +
          'ORDER BY e2.created_at DESC, e2.rowid DESC LIMIT 1) ' +
          `AND ${scoreBounds.join(' AND ')})`,
      );
      if (filter.min_score !== undefined) params.push(filter.min_score);
      if (filter.max_score !== undefined) params.push(filter.max_score);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const sortBy = options.sort_by ?? 'timestamp';
    const sortOrder = options.sort_order ?? 'desc';

    if (!ALLOWED_SORT_COLUMNS.has(sortBy)) {
      throw new Error(`Invalid sort column: ${sortBy} (allowed: ${[...ALLOWED_SORT_COLUMNS].join(', ')})`);
    }
    if (!ALLOWED_SORT_ORDERS.has(sortOrder)) {
      throw new Error(`Invalid sort order: ${sortOrder} (allowed: ${[...ALLOWED_SORT_ORDERS].join(', ')})`);
    }
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    const countRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM traces ${whereClause}`)
      .get(...params) as { count: number };

    const rows = this.db
      .prepare(`SELECT * FROM traces ${whereClause} ORDER BY ${sortBy} ${sortOrder} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    return {
      traces: rows.map((row) => this.rowToTrace(row)),
      total: countRow.count,
      limit,
      offset,
    };
  }

  async insertSpan(tenantId: TenantId, span: Span): Promise<void> {
    assertTenant(tenantId);
    this.db.prepare(`
      INSERT INTO spans (tenant_id, span_id, trace_id, parent_span_id, name, kind, status_code, status_message, start_time, end_time, attributes, events)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tenantId,
      span.span_id,
      span.trace_id,
      span.parent_span_id ?? null,
      span.name,
      span.kind,
      span.status_code,
      span.status_message ?? null,
      span.start_time,
      span.end_time ?? null,
      span.attributes ? JSON.stringify(span.attributes) : null,
      span.events ? JSON.stringify(span.events) : null,
    );
  }

  async getSpansByTraceId(tenantId: TenantId, traceId: string): Promise<Span[]> {
    assertTenant(tenantId);
    const rows = this.db
      .prepare('SELECT * FROM spans WHERE tenant_id = ? AND trace_id = ? ORDER BY start_time')
      .all(tenantId, traceId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToSpan(row));
  }

  async insertEvalResult(tenantId: TenantId, result: EvalResult): Promise<void> {
    assertTenant(tenantId);
    /*
     * created_at is written EXPLICITLY as ISO-8601. Leaving it to the
     * column DEFAULT (datetime('now')) stored "2026-08-09 15:00:00", which
     * every period query then compared as a string against a JS
     * toISOString() boundary — and ' ' sorts before 'T', so any eval whose
     * calendar date matched the boundary's date was dropped from the
     * window. Migration 005 rewrites rows written before this line existed.
     */
    /*
     * critical_failures is PERSISTED (migration 006) because the veto is a
     * verdict, not a presentation detail. It used to live only in the live
     * tool response, so the moment an evaluation was stored a vetoed eval
     * became indistinguishable from one that merely scored below threshold —
     * no surface could filter, count, or explain the release's flagship
     * behaviour. NULL when nothing vetoed.
     */
    /*
     * Provenance (migration 007) is the part of the receipt a row cannot
     * reconstruct: the release, the ruleset and config hashes, the threshold.
     * verdict / coverage / critical_skipped are derived on every read from
     * rule_results plus that threshold, so they are not columns.
     */
    this.db.prepare(`
      INSERT INTO eval_results (tenant_id, id, trace_id, eval_type, output_text, expected_text, score, passed, rule_results, suggestions, rules_evaluated, rules_skipped, insufficient_data, critical_failures, created_at, provenance, engine_version, ruleset_hash, config_hash, threshold, eval_cost_usd, eval_tokens, run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tenantId,
      result.id,
      result.trace_id ?? null,
      result.eval_type,
      this.storedOutputText(result),
      result.expected_text ?? null,
      result.score,
      result.passed ? 1 : 0,
      JSON.stringify(result.rule_results),
      JSON.stringify(result.suggestions),
      result.rules_evaluated ?? null,
      result.rules_skipped ?? null,
      result.insufficient_data ? 1 : 0,
      result.critical_failures?.length ? JSON.stringify(result.critical_failures) : null,
      /*
       * EvalResult has declared `created_at` since the type existed and this
       * insert discarded it, so an imported or backdated evaluation silently
       * became "now" — the same accepted-and-dropped shape as log_trace's
       * tools catalogue. Honoured when supplied, and still defaulted to now,
       * which is what every caller in this package relies on.
       */
      result.created_at ?? new Date().toISOString(),
      result.provenance ? JSON.stringify(result.provenance) : null,
      result.provenance?.irisVersion ?? null,
      result.provenance?.rulesetHash ?? null,
      result.provenance?.configHash ?? null,
      result.provenance?.thresholds.default ?? null,
      result.eval_cost_usd ?? null,
      result.eval_tokens ?? null,
      // Set only by a re-evaluation. Left null, the evaluation belongs to
      // whatever run its trace does — which is right for every normal call.
      result.run_id ?? null,
    );
  }

  async getEvalsByTraceId(tenantId: TenantId, traceId: string): Promise<EvalResult[]> {
    assertTenant(tenantId);
    const rows = this.db
      .prepare('SELECT * FROM eval_results WHERE tenant_id = ? AND trace_id = ? ORDER BY created_at DESC')
      .all(tenantId, traceId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToEvalResult(row));
  }

  /**
   * Every evaluation in a run, one per trace, newest first.
   *
   * A trace can be evaluated more than once — re-run the rules and there
   * are two rows for one execution. Counting both would double a case and
   * quietly weight it twice in a pass rate, so this keeps the MOST RECENT
   * evaluation per trace and says how many it collapsed. That number is
   * reported rather than hidden: a run whose traces were each evaluated
   * three times is a run somebody re-ran, and a reader comparing it to
   * another should know.
   *
   * The run of an evaluation is `eval_results.run_id` when set, and the
   * run of its TRACE otherwise. Both exist for a reason: an ordinary
   * evaluation belongs to whatever batch its execution belonged to, and
   * deriving that from the trace keeps one source of truth. A
   * RE-EVALUATION belongs to a batch its trace never saw, and that is the
   * case the column exists for.
   */
  /**
   * Register (or update) a run. Only the two facts that cannot be derived
   * are written: the caller's label and, for a re-evaluation, what it re-ran.
   * Everything else a reader wants about a run is counted from its rows.
   */
  async upsertRun(
    tenantId: TenantId,
    run: { runId: string; label?: string | null; agentName?: string | null; reevaluationOf?: string | null },
  ): Promise<void> {
    assertTenant(tenantId);
    this.db
      .prepare(
        `INSERT INTO runs (run_id, tenant_id, label, agent_name, reevaluation_of)
              VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           label = COALESCE(excluded.label, runs.label),
           agent_name = COALESCE(excluded.agent_name, runs.agent_name),
           reevaluation_of = COALESCE(excluded.reevaluation_of, runs.reevaluation_of)`,
      )
      .run(run.runId, tenantId, run.label ?? null, run.agentName ?? null, run.reevaluationOf ?? null);
  }

  /**
   * Every run this tenant has, newest first.
   *
   * The listing is the UNION of registered runs and run ids found on traces
   * or evaluations, because a run id arrives on a log_trace call long before
   * anything registers it — a caller who passes `run` and nothing else must
   * still see their run here. A registered run with no rows yet is listed
   * too, so a re-evaluation that produced nothing is visible rather than
   * silently absent.
   */
  async listRuns(tenantId: TenantId, limit = 50): Promise<RunSummaryRow[]> {
    assertTenant(tenantId);
    const rows = this.db
      .prepare(
        `WITH ids(run_id) AS (
             SELECT run_id FROM runs WHERE tenant_id = ? AND run_id IS NOT NULL
             UNION SELECT run_id FROM traces WHERE tenant_id = ? AND run_id IS NOT NULL
             UNION SELECT run_id FROM eval_results WHERE tenant_id = ? AND run_id IS NOT NULL
           )
           SELECT i.run_id                                                                              AS run_id,
                  r.label                                                                               AS label,
                  r.reevaluation_of                                                                     AS reevaluation_of,
                  (SELECT COUNT(*) FROM traces t WHERE t.tenant_id = ? AND t.run_id = i.run_id)         AS traces,
                  COALESCE(r.started_at,
                           (SELECT MIN(t.timestamp) FROM traces t WHERE t.tenant_id = ? AND t.run_id = i.run_id)) AS started_at,
                  (SELECT MAX(t.timestamp) FROM traces t WHERE t.tenant_id = ? AND t.run_id = i.run_id) AS last_trace_at
             FROM ids i
             LEFT JOIN runs r ON r.run_id = i.run_id AND r.tenant_id = ?
            ORDER BY started_at DESC, i.run_id DESC
            LIMIT ?`,
      )
      .all(tenantId, tenantId, tenantId, tenantId, tenantId, tenantId, tenantId, limit) as Array<Record<string, unknown>>;

    const out: RunSummaryRow[] = [];
    for (const row of rows) {
      const runId = String(row.run_id);
      // Counted through the same collapsed view a comparison uses, so a run's
      // listed `evaluated` can never disagree with what compare_runs read.
      const results = await this.getRunResults(tenantId, runId);
      const lastEval = results.reduce<string | null>((acc, r) => (acc === null || r.createdAt > acc ? r.createdAt : acc), null);
      const lastTrace = (row.last_trace_at as string | null) ?? null;
      out.push({
        runId,
        label: (row.label as string | null) ?? null,
        reevaluationOf: (row.reevaluation_of as string | null) ?? null,
        traces: Number(row.traces ?? 0),
        evaluated: results.length,
        passed: results.filter((r) => r.passed).length,
        agentNames: [...new Set(results.map((r) => r.agentName).filter((v): v is string => v !== null))].sort(),
        engineVersions: [...new Set(results.map((r) => r.engineVersion).filter((v): v is string => v !== null))].sort(),
        rulesetHashes: [...new Set(results.map((r) => r.rulesetHash).filter((v): v is string => v !== null))].sort(),
        startedAt: (row.started_at as string | null) ?? null,
        lastActivityAt: lastEval !== null && (lastTrace === null || lastEval > lastTrace) ? lastEval : lastTrace,
      });
    }
    return out;
  }

  /** One run, or null when no trace, evaluation or registration mentions it. */
  async getRun(tenantId: TenantId, runId: string): Promise<RunSummaryRow | null> {
    assertTenant(tenantId);
    const known = this.db
      .prepare(
        `SELECT 1 AS hit FROM runs WHERE tenant_id = ? AND run_id = ?
          UNION SELECT 1 FROM traces WHERE tenant_id = ? AND run_id = ?
          UNION SELECT 1 FROM eval_results WHERE tenant_id = ? AND run_id = ?
          LIMIT 1`,
      )
      .get(tenantId, runId, tenantId, runId, tenantId, runId);
    if (known === undefined) return null;
    const all = await this.listRuns(tenantId, 1000);
    return all.find((r) => r.runId === runId) ?? null;
  }

  /**
   * Every trace in a run, with whether its latest evaluation was produced
   * under a given ruleset. This is the question `evaluate_runs` asks:
   * re-evaluating a trace whose verdict already came from the current rules
   * would spend work to reproduce a row that exists.
   */
  async getRunTraceEvaluationState(
    tenantId: TenantId,
    runId: string,
    rulesetHash: string,
  ): Promise<Array<{ traceId: string; evaluatedUnderRuleset: boolean }>> {
    assertTenant(tenantId);
    const rows = this.db
      .prepare(
        `SELECT t.trace_id AS trace_id,
                (SELECT e.ruleset_hash FROM eval_results e
                  WHERE e.tenant_id = t.tenant_id AND e.trace_id = t.trace_id
                  ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS latest_ruleset
           FROM traces t
          WHERE t.tenant_id = ? AND t.run_id = ?
          ORDER BY t.timestamp ASC`,
      )
      .all(tenantId, runId) as Array<{ trace_id: string; latest_ruleset: string | null }>;
    return rows.map((r) => ({ traceId: r.trace_id, evaluatedUnderRuleset: r.latest_ruleset === rulesetHash }));
  }

  async getRunResults(tenantId: TenantId, runId: string): Promise<RunResultRow[]> {
    assertTenant(tenantId);
    const rows = this.db
      .prepare(
        `SELECT e.id, e.trace_id, e.passed, e.rule_results, e.engine_version, e.ruleset_hash, e.config_hash, e.created_at,
                t.case_key, t.agent_name
           FROM eval_results e
           LEFT JOIN traces t ON t.trace_id = e.trace_id AND t.tenant_id = e.tenant_id
          WHERE e.tenant_id = ? AND COALESCE(e.run_id, t.run_id) = ?
          ORDER BY e.created_at DESC, e.id DESC`,
      )
      .all(tenantId, runId) as Array<Record<string, unknown>>;

    const seen = new Set<string>();
    const out: RunResultRow[] = [];
    let superseded = 0;
    for (const row of rows) {
      const traceId = (row.trace_id as string | null) ?? `eval:${String(row.id)}`;
      if (seen.has(traceId)) {
        superseded += 1;
        continue;
      }
      seen.add(traceId);
      const ruleResults = row.rule_results ? (JSON.parse(row.rule_results as string) as Array<{ ruleName: string; passed: boolean; skipped?: boolean }>) : [];
      out.push({
        evalId: String(row.id),
        traceId: (row.trace_id as string | null) ?? null,
        caseKey: (row.case_key as string | null) ?? null,
        agentName: (row.agent_name as string | null) ?? null,
        passed: row.passed === 1 || row.passed === true,
        failedRules: ruleResults.filter((r) => r.skipped !== true && r.passed === false).map((r) => r.ruleName),
        engineVersion: (row.engine_version as string | null) ?? null,
        rulesetHash: (row.ruleset_hash as string | null) ?? null,
        configHash: (row.config_hash as string | null) ?? null,
        createdAt: String(row.created_at),
      });
    }
    if (superseded > 0) out.forEach((r) => (r.supersededInRun = superseded));
    return out;
  }

  /**
   * Every evaluation that carries a case key, optionally narrowed.
   *
   * Deliberately NOT collapsed to one row per trace, unlike getRunResults.
   * There the question is "how did this run do", and a trace evaluated
   * twice is one case that would otherwise be weighted twice. Here the
   * question is "how reliably does the agent answer this", and every
   * attempt is a real attempt — collapsing them would erase the very
   * repetition being measured.
   */
  async getCaseResults(tenantId: TenantId, filter: { run?: string; caseKey?: string } = {}): Promise<CaseResultRow[]> {
    assertTenant(tenantId);
    const where: string[] = ['e.tenant_id = ?', 't.case_key IS NOT NULL'];
    const params: unknown[] = [tenantId];
    if (filter.run !== undefined) {
      where.push('COALESCE(e.run_id, t.run_id) = ?');
      params.push(filter.run);
    }
    if (filter.caseKey !== undefined) {
      where.push('t.case_key = ?');
      params.push(filter.caseKey);
    }
    const rows = this.db
      .prepare(
        `SELECT e.id, e.trace_id, e.passed, e.created_at, t.case_key, COALESCE(e.run_id, t.run_id) AS run_id
           FROM eval_results e
           JOIN traces t ON t.trace_id = e.trace_id AND t.tenant_id = e.tenant_id
          WHERE ${where.join(' AND ')}
          ORDER BY e.created_at ASC, e.id ASC`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      evalId: String(row.id),
      traceId: (row.trace_id as string | null) ?? null,
      caseKey: (row.case_key as string | null) ?? null,
      runId: (row.run_id as string | null) ?? null,
      passed: row.passed === 1 || row.passed === true,
      createdAt: String(row.created_at),
    }));
  }

  async getEvalById(tenantId: TenantId, id: string): Promise<EvalResult | null> {
    assertTenant(tenantId);
    const row = this.db
      .prepare('SELECT * FROM eval_results WHERE tenant_id = ? AND id = ?')
      .get(tenantId, id) as Record<string, unknown> | undefined;
    return row ? this.rowToEvalResult(row) : null;
  }

  async queryEvalResults(
    tenantId: TenantId,
    options: {
      eval_type?: string;
      passed?: boolean;
      since?: string;
      until?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<{ results: EvalResult[]; total: number }> {
    assertTenant(tenantId);
    const conditions: string[] = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];

    if (options.eval_type) {
      conditions.push('eval_type = ?');
      params.push(options.eval_type);
    }
    if (options.passed !== undefined) {
      conditions.push('passed = ?');
      params.push(options.passed ? 1 : 0);
    }
    if (options.since) {
      conditions.push('created_at >= ?');
      params.push(options.since);
    }
    if (options.until) {
      conditions.push('created_at <= ?');
      params.push(options.until);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    const countRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM eval_results ${whereClause}`)
      .get(...params) as { count: number };

    const rows = this.db
      .prepare(`SELECT * FROM eval_results ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    return {
      results: rows.map((row) => this.rowToEvalResult(row)),
      total: countRow.count,
    };
  }

  async getDashboardSummary(tenantId: TenantId, sinceHours = 24): Promise<DashboardSummary> {
    assertTenant(tenantId);
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();

    const stats = this.db.prepare(`
      SELECT
        COUNT(*) as total_traces,
        COALESCE(AVG(latency_ms), 0) as avg_latency_ms,
        COALESCE(SUM(cost_usd), 0) as total_cost_usd
      FROM traces WHERE tenant_id = ? AND timestamp >= ?
    `).get(tenantId, since) as { total_traces: number; avg_latency_ms: number; total_cost_usd: number };

    const errorCount = this.db.prepare(`
      SELECT COUNT(DISTINCT t.trace_id) as count
      FROM traces t
      JOIN spans s ON s.tenant_id = t.tenant_id AND s.trace_id = t.trace_id
      WHERE t.tenant_id = ? AND t.timestamp >= ? AND s.status_code = 'ERROR'
    `).get(tenantId, since) as { count: number };

    const evalStats = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) as passed_count
      FROM eval_results WHERE tenant_id = ? AND created_at >= ?
    `).get(tenantId, since) as { total: number; passed_count: number };

    const tracesPerHour = this.db.prepare(`
      SELECT strftime('%Y-%m-%dT%H:00:00', timestamp) as hour, COUNT(*) as count
      FROM traces WHERE tenant_id = ? AND timestamp >= ?
      GROUP BY hour ORDER BY hour
    `).all(tenantId, since) as Array<{ hour: string; count: number }>;

    const topAgents = this.db.prepare(`
      SELECT agent_name, COUNT(*) as count
      FROM traces WHERE tenant_id = ? AND timestamp >= ?
      GROUP BY agent_name ORDER BY count DESC LIMIT 10
    `).all(tenantId, since) as Array<{ agent_name: string; count: number }>;

    return {
      total_traces: stats.total_traces,
      avg_latency_ms: Math.round(stats.avg_latency_ms * 100) / 100,
      total_cost_usd: Math.round(stats.total_cost_usd * 10000) / 10000,
      error_rate: stats.total_traces > 0 ? errorCount.count / stats.total_traces : 0,
      eval_pass_rate: evalStats.total > 0 ? evalStats.passed_count / evalStats.total : 0,
      traces_per_hour: tracesPerHour,
      top_agents: topAgents,
    };
  }

  // ---------------------------------------------------------------------------
  // Eval-stats endpoints (v0.2.0 dashboard)
  // ---------------------------------------------------------------------------

  /*
   * Table-driven rather than a nested ternary: the old form silently fell
   * through to 720 hours for anything that wasn't '24h' or '7d', so a new
   * period value would have quietly returned 30d data rather than failing.
   */
  private static readonly PERIOD_HOURS: Record<Exclude<EvalStatsPeriod, 'all'>, number> = {
    '24h': 24,
    '2d': 48,
    '7d': 168,
    '14d': 336,
    '30d': 720,
    '60d': 1440,
    '90d': 2160,
    '180d': 4320,
  };

  private periodToSince(period: EvalStatsPeriod): string {
    if (period === 'all') return '1970-01-01T00:00:00.000Z';
    const hours = SqliteAdapter.PERIOD_HOURS[period];
    return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  }

  async getEvalStats(tenantId: TenantId, period: EvalStatsPeriod): Promise<EvalStats> {
    assertTenant(tenantId);
    const since = this.periodToSince(period);

    /*
     * No trace_id filter — deliberately. evaluate_output without a
     * trace_id is documented and normal, and every sibling scan (trend,
     * per-rule breakdown, failures) counts unlinked evals. Filtering only
     * this headline made totalEvals disagree with the trend's sum, and —
     * because eval_results.trace_id is ON DELETE SET NULL — deleting a
     * trace retroactively shrank the headline while the trend kept the
     * eval. One population everywhere: every eval in the window.
     */
    const agg = this.db.prepare(`
      SELECT
        COUNT(*)                                     AS total_evals,
        COALESCE(AVG(score), 0)                      AS avg_score,
        SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS passed_count
      FROM eval_results
      WHERE tenant_id = ? AND created_at >= ?
    `).get(tenantId, since) as { total_evals: number; avg_score: number; passed_count: number };

    const cost = this.db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS total_cost
      FROM traces
      WHERE tenant_id = ? AND timestamp >= ?
    `).get(tenantId, since) as { total_cost: number };

    const agents = this.db.prepare(`
      SELECT COUNT(DISTINCT agent_name) AS agent_count
      FROM traces
      WHERE tenant_id = ? AND timestamp >= ?
    `).get(tenantId, since) as { agent_count: number };

    /*
     * No `AND passed = 0` here — deliberately.
     *
     * A safety eval's score is the average across its rules, so a single
     * violation is routinely outvoted: output containing "Your SSN is
     * 123-45-6789" fails no_pii (score 0) while the three other safety
     * rules pass, giving 0.733 overall — above the 0.7 threshold, so
     * passed = 1. Filtering to failed evals therefore reported
     * {pii: 0, injection: 0, hallucination: 0} for a trace that leaked a
     * social security number.
     *
     * For a product whose job is catching PII, injection and hallucination,
     * that error ran in the direction that HIDES problems. The count is
     * per-VIOLATION, not per-failed-eval; the per-rule loop below already
     * skips rules that passed, so scanning every safety eval in the window
     * is both correct and sufficient.
     */
    /*
     * eval_type IN ('safety', 'all'): an eval_type="all" run carries the
     * whole safety bundle inside its rule_results, and a PII leak caught
     * there is exactly as real as one caught by a safety-only run. The
     * per-rule loop below keys on rule NAMES, so the wider filter cannot
     * over-count.
     */
    const safetyRows = this.db.prepare(`
      SELECT rule_results
      FROM eval_results
      WHERE tenant_id = ? AND created_at >= ?
        AND eval_type IN ('safety', 'all')
    `).all(tenantId, since) as Array<{ rule_results: string }>;

    const violations = { pii: 0, injection: 0, hallucination: 0 };
    for (const row of safetyRows) {
      const rules: Array<{ ruleName: string; passed: boolean }> = JSON.parse(row.rule_results);
      for (const r of rules) {
        if (r.passed) continue;
        if (r.ruleName === 'no_pii') violations.pii++;
        if (r.ruleName === 'no_injection_patterns') violations.injection++;
        if (r.ruleName === 'no_hallucination_markers') violations.hallucination++;
      }
    }

    return {
      passRate: agg.total_evals > 0
        ? Math.round((agg.passed_count / agg.total_evals) * 1000) / 1000
        : 0,
      avgScore: Math.round(agg.avg_score * 1000) / 1000,
      totalEvals: agg.total_evals,
      safetyViolations: violations,
      totalCost: Math.round(cost.total_cost * 10000) / 10000,
      agentCount: agents.agent_count,
      period,
    };
  }

  async getEvalStatsTrend(tenantId: TenantId, period: EvalStatsPeriod, cohortBy?: TrendCohort): Promise<EvalStatsTrendBucket[]> {
    assertTenant(tenantId);
    const since = this.periodToSince(period);

    let bucketExpr: string;
    if (period === '24h') {
      bucketExpr = "strftime('%Y-%m-%dT%H:00:00Z', e.created_at)";
    } else if (period === '7d') {
      bucketExpr =
        "strftime('%Y-%m-%dT', e.created_at) || printf('%02d', (CAST(strftime('%H', e.created_at) AS INTEGER) / 6) * 6) || ':00:00Z'";
    } else {
      bucketExpr = "strftime('%Y-%m-%dT00:00:00Z', e.created_at)";
    }

    /*
     * The cohort of an evaluation is its own run when it has one, and its
     * trace's run otherwise — the same COALESCE every run read uses. A
     * re-evaluation carries its own run_id precisely so it lands in the new
     * cohort rather than back in the run whose traces it re-scored.
     *
     * 'run' is the only value the type admits, so this is a fixed string
     * chosen by a closed union rather than caller text reaching SQL.
     */
    const cohortExpr = cohortBy === 'run' ? 'COALESCE(e.run_id, t.run_id)' : 'NULL';

    const rows = this.db.prepare(`
      SELECT
        ${bucketExpr}                                  AS bucket,
        ${cohortExpr}                                  AS cohort,
        COALESCE(AVG(e.score), 0)                      AS avg_score,
        CASE WHEN COUNT(*) > 0
          THEN CAST(SUM(CASE WHEN e.passed = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*)
          ELSE 0 END                                   AS pass_rate,
        COUNT(*)                                       AS eval_count
      FROM eval_results e
      LEFT JOIN traces t ON t.trace_id = e.trace_id AND t.tenant_id = e.tenant_id
      WHERE e.tenant_id = ? AND e.created_at >= ?
      GROUP BY bucket, cohort
      ORDER BY bucket, cohort
    `).all(tenantId, since) as Array<{
      bucket: string;
      cohort: string | null;
      avg_score: number;
      pass_rate: number;
      eval_count: number;
    }>;

    return rows.map((r) => ({
      timestamp: r.bucket,
      avgScore: Math.round(r.avg_score * 1000) / 1000,
      passRate: Math.round(r.pass_rate * 1000) / 1000,
      evalCount: r.eval_count,
      ...(cohortBy === undefined ? {} : { cohort: r.cohort }),
    }));
  }

  /**
   * One window's pass counts, so a drift comparison has denominators.
   *
   * Counts EVALUATIONS, not traces: an evaluation is the unit that passed
   * or failed, which is what the rate is a rate of. A run filter joins the
   * traces table for the same COALESCE every run read uses, so a
   * re-evaluation lands in the cohort it was written into.
   */
  /**
   * This agent's recent evaluated traces and what failed in each.
   *
   * Returned as a LOG rather than a collapsed "has this ever failed" answer,
   * because the moments list needs the answer AS OF each of up to two hundred
   * traces. Collapsing in SQL would mean one query per trace — two hundred
   * scans on a page render, each parsing a JSON blob per row. One query per
   * distinct agent, filtered by timestamp in memory, is the same answer for a
   * fraction of the work.
   *
   * Bounded, and the bound is real rather than defensive: this runs on a page
   * render and an agent with a hundred thousand evaluations would otherwise
   * make the list slower the longer someone has used the product. The cost is
   * that a rule which last failed very long ago can read as a first failure.
   * That is the right trade for a ranking signal, and it is why this drives
   * presentation and never a verdict.
   */
  async getAgentFailureLog(tenantId: TenantId, agentName: string, limit = 500): Promise<AgentFailureLogEntry[]> {
    assertTenant(tenantId);
    const rows = this.db
      .prepare(
        `SELECT e.rule_results AS rule_results, t.trace_id AS trace_id, t.timestamp AS timestamp
           FROM eval_results e
           JOIN traces t ON t.trace_id = e.trace_id AND t.tenant_id = e.tenant_id
          WHERE e.tenant_id = ? AND t.agent_name = ?
          ORDER BY t.timestamp DESC, e.created_at DESC
          LIMIT ?`,
      )
      .all(tenantId, agentName, limit) as Array<{ rule_results: string | null; trace_id: string; timestamp: string }>;

    // A trace evaluated more than once contributes ONE entry, its newest —
    // the same collapse every run read performs, for the same reason: a
    // re-evaluated trace is one trace, not two.
    const seen = new Set<string>();
    const out: AgentFailureLogEntry[] = [];
    for (const row of rows) {
      if (seen.has(row.trace_id)) continue;
      seen.add(row.trace_id);
      const results = row.rule_results === null ? [] : (JSON.parse(row.rule_results) as Array<{ ruleName: string; passed: boolean; skipped?: boolean }>);
      out.push({
        traceId: row.trace_id,
        timestamp: row.timestamp,
        failed: results.filter((r) => r.skipped !== true && r.passed === false).map((r) => r.ruleName).sort(),
      });
    }
    return out;
  }

  async getDriftWindow(tenantId: TenantId, since: string, until: string | null, run?: string): Promise<DriftWindow> {
    assertTenant(tenantId);
    const where: string[] = ['e.tenant_id = ?', 'e.created_at >= ?'];
    const params: unknown[] = [tenantId, since];
    if (until !== null) {
      where.push('e.created_at < ?');
      params.push(until);
    }
    if (run !== undefined) {
      where.push('COALESCE(e.run_id, t.run_id) = ?');
      params.push(run);
    }
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS evaluated,
                SUM(CASE WHEN e.passed = 1 THEN 1 ELSE 0 END) AS passed
           FROM eval_results e
           LEFT JOIN traces t ON t.trace_id = e.trace_id AND t.tenant_id = e.tenant_id
          WHERE ${where.join(' AND ')}`,
      )
      .get(...params) as { evaluated: number; passed: number | null };

    const evaluated = Number(row.evaluated ?? 0);
    const passed = Number(row.passed ?? 0);
    return {
      since,
      until,
      evaluated,
      passed,
      // "0 of 0" is unknown, not zero. A window with nothing in it that
      // reported a rate of 0 would draw a cliff on the chart.
      passRate: evaluated > 0 ? passed / evaluated : null,
    };
  }

  async getEvalStatsRules(tenantId: TenantId, period: EvalStatsPeriod): Promise<EvalStatsRuleBreakdown[]> {
    assertTenant(tenantId);
    const since = this.periodToSince(period);

    const rows = this.db.prepare(`
      SELECT rule_results
      FROM eval_results
      WHERE tenant_id = ? AND created_at >= ?
    `).all(tenantId, since) as Array<{ rule_results: string }>;

    const ruleMap = new Map<string, { totalRun: number; failCount: number }>();

    for (const row of rows) {
      const rules: Array<{ ruleName: string; passed: boolean; skipped?: boolean }> = JSON.parse(row.rule_results);
      for (const r of rules) {
        if (r.skipped) continue;
        const entry = ruleMap.get(r.ruleName) ?? { totalRun: 0, failCount: 0 };
        entry.totalRun++;
        if (!r.passed) entry.failCount++;
        ruleMap.set(r.ruleName, entry);
      }
    }

    const result: EvalStatsRuleBreakdown[] = [];
    for (const [rule, stats] of ruleMap) {
      result.push({
        rule,
        passRate: stats.totalRun > 0
          ? Math.round(((stats.totalRun - stats.failCount) / stats.totalRun) * 1000) / 1000
          : 0,
        totalRun: stats.totalRun,
        failCount: stats.failCount,
      });
    }

    result.sort((a, b) => a.passRate - b.passRate);

    return result;
  }

  async getEvalStatsFailures(tenantId: TenantId, period: EvalStatsPeriod, limit: number): Promise<EvalStatsFailure[]> {
    assertTenant(tenantId);
    const since = this.periodToSince(period);

    const rows = this.db.prepare(`
      SELECT
        e.trace_id,
        COALESCE(t.agent_name, 'unknown') AS agent_name,
        e.rule_results,
        e.score,
        e.output_text,
        e.created_at
      FROM eval_results e
      LEFT JOIN traces t ON t.tenant_id = e.tenant_id AND t.trace_id = e.trace_id
      WHERE e.tenant_id = ? AND e.created_at >= ?
        AND e.passed = 0
      ORDER BY e.created_at DESC
      LIMIT ?
    `).all(tenantId, since, limit) as Array<{
      trace_id: string | null;
      agent_name: string;
      rule_results: string;
      score: number;
      output_text: string;
      created_at: string;
    }>;

    return rows.map((r) => {
      const rules: Array<{ ruleName: string; passed: boolean }> = JSON.parse(r.rule_results);
      const failingRule = rules.find((rule) => !rule.passed);

      return {
        traceId: r.trace_id ?? '',
        agent: r.agent_name,
        rule: failingRule?.ruleName ?? 'unknown',
        score: Math.round(r.score * 1000) / 1000,
        output: r.output_text.length > 200 ? r.output_text.slice(0, 200) + '...' : r.output_text,
        timestamp: r.created_at,
      };
    });
  }

  async deleteTracesOlderThan(tenantId: TenantId, days: number): Promise<number> {
    assertTenant(tenantId);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    // Same erasure as deleteTrace: an evaluation younger than the window
    // whose trace is swept keeps its verdict and loses its text.
    const run = this.db.transaction((tid: TenantId, cut: string): number => {
      const ids = (this.db.prepare('SELECT trace_id FROM traces WHERE tenant_id = ? AND timestamp < ?').all(tid, cut) as Array<{ trace_id: string }>).map((r) => r.trace_id);
      this.eraseEvaluationsOfTraces(tid, ids);
      return this.db.prepare('DELETE FROM traces WHERE tenant_id = ? AND timestamp < ?').run(tid, cut).changes;
    });
    return run(tenantId, cutoff);
  }

  async deleteEvalResultsOlderThan(tenantId: TenantId, days: number): Promise<number> {
    assertTenant(tenantId);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    /*
     * created_at, not the linked trace's timestamp: an unlinked eval has
     * no trace, and a linked one whose trace was already swept has a NULL
     * trace_id — either way the eval's own age is the only age it has.
     * Rows are ISO-8601 here (write path + migration 005), so the string
     * comparison against an ISO cutoff is exact.
     */
    const result = this.db
      .prepare('DELETE FROM eval_results WHERE tenant_id = ? AND created_at < ?')
      .run(tenantId, cutoff);
    return result.changes;
  }

  async purge(tenantId: TenantId): Promise<{ traces: number; evalResults: number }> {
    assertTenant(tenantId);
    const deleteAll = this.db.transaction(() => {
      const evalResults = this.db.prepare('DELETE FROM eval_results WHERE tenant_id = ?').run(tenantId).changes;
      // spans cascade (FK ON DELETE CASCADE).
      const traces = this.db.prepare('DELETE FROM traces WHERE tenant_id = ?').run(tenantId).changes;
      return { traces, evalResults };
    });
    const counts = deleteAll();
    /*
     * VACUUM rebuilds the file from the live rows only — the freed pages
     * (already zeroed by secure_delete) are dropped rather than kept as
     * free-list slack — and the TRUNCATE checkpoint then folds the WAL into
     * the main file and cuts it to zero bytes, so neither iris.db nor
     * iris.db-wal keeps a copy of what was just deleted. Skipped for
     * :memory: (nothing on disk to clean).
     */
    if (this.dbPath !== ':memory:') {
      this.db.exec('VACUUM');
    }
    await this.checkpoint();
    return counts;
  }

  async checkpoint(): Promise<void> {
    if (this.dbPath === ':memory:') return;
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // Best effort: a checkpoint can be refused while another connection
      // holds a read transaction. The next one will pick the pages up.
    }
  }

  async deleteTrace(tenantId: TenantId, traceId: string): Promise<boolean> {
    assertTenant(tenantId);
    // Tenant-scoped: a trace id owned by a different tenant is
    // untouchable from this call. Cross-tenant deletions are not just
    // denied — they're invisible (no indication the id even exists).
    //
    // The right-to-erasure fix: eval_results.trace_id is ON DELETE SET
    // NULL, so the delete alone left every linked evaluation behind with
    // output_text verbatim — including what no_pii had flagged — orphaned
    // and readable. The text is erased in the same transaction, BEFORE the
    // FK can orphan the rows.
    const run = this.db.transaction((tid: TenantId, id: string): number => {
      const exists = this.db.prepare('SELECT 1 FROM traces WHERE tenant_id = ? AND trace_id = ?').get(tid, id);
      if (!exists) return 0;
      this.eraseEvaluationsOfTraces(tid, [id]);
      return this.db.prepare('DELETE FROM traces WHERE tenant_id = ? AND trace_id = ?').run(tid, id).changes;
    });
    return run(tenantId, traceId) > 0;
  }

  /**
   * Blank every text field of the evaluations linked to these traces and
   * stamp erased_at (migration 007). Verdict, scores, criticality and the
   * evidence OFFSETS stay — they carry no text — so history and drift
   * analytics keep working over an erased row.
   */
  private eraseEvaluationsOfTraces(tenantId: TenantId, traceIds: readonly string[]): number {
    if (traceIds.length === 0) return 0;
    const now = new Date().toISOString();
    const select = this.db.prepare('SELECT id, rule_results FROM eval_results WHERE tenant_id = ? AND trace_id = ?');
    const update = this.db.prepare(
      'UPDATE eval_results SET output_text = ?, expected_text = NULL, suggestions = ?, rule_results = ?, erased_at = ? WHERE tenant_id = ? AND id = ?',
    );
    let erased = 0;
    for (const traceId of traceIds) {
      for (const row of select.all(tenantId, traceId) as Array<{ id: string; rule_results: string }>) {
        let rules: EvalRuleResult[] = [];
        try {
          rules = JSON.parse(row.rule_results) as EvalRuleResult[];
        } catch {
          rules = [];
        }
        const erasedRules = rules.map((r) => ({
          ...r,
          message: ERASED_MESSAGE,
          ...(r.skipReason ? { skipReason: ERASED_MESSAGE } : {}),
        }));
        update.run('', '[]', JSON.stringify(erasedRules), now, tenantId, row.id);
        erased += 1;
      }
    }
    return erased;
  }

  /**
   * storage.redact = 'critical_spans': the spans a critical detector fired
   * on are replaced in the STORED text by [REDACTED:<pattern>]. The
   * evidence offsets are left as computed — they index the text the caller
   * saw, which is what a reader of the evidence needs — and the option's
   * documentation says so.
   *
   * ONLY spans into the agent's own output, and from 0.11.0 that is a
   * decision rather than an accident. `no_injection_compliance` is the first
   * rule to report a span whose source is `tool_outputs[i]`, and those
   * offsets index a TOOL RESULT, not this text — splicing them here would
   * corrupt stored output at meaningless positions. The filter below is what
   * stops that, and the test in tests/unit/storage/redact.test.ts is what
   * keeps it stopped.
   *
   * The trace itself is deliberately NOT redacted, and this is a stated
   * non-goal rather than an omission: an injected payload inside a stored
   * tool result is the RECORD OF THE ATTACK. Stripping it would destroy the
   * evidence that the verdict points at, leaving a finding whose subject no
   * longer exists. A deployment that must not retain such text deletes the
   * trace, which erases it.
   */
  private storedOutputText(result: EvalResult): string | null {
    const text = result.output_text;
    if (this.redact !== 'critical_spans' || !text) return text ?? null;
    const spans = result.rule_results
      .filter((r) => r.critical === true && !r.passed && !r.skipped)
      // `source === 'output'` is load-bearing: see the note above.
      .flatMap((r) => (r.evidence ?? []).filter((e): e is Extract<Evidence, { type: 'span' }> => e.type === 'span' && e.source === 'output'));
    if (spans.length === 0) return text;
    const seen = new Set<string>();
    let out = text;
    for (const s of [...spans].sort((a, b) => b.start - a.start)) {
      const key = `${s.start}:${s.end}`;
      if (seen.has(key) || s.start >= s.end || s.end > out.length) continue;
      seen.add(key);
      out = `${out.slice(0, s.start)}[REDACTED:${s.label}]${out.slice(s.end)}`;
    }
    return out;
  }

  async getDistinctValues(tenantId: TenantId, column: string): Promise<string[]> {
    assertTenant(tenantId);
    const queries: Record<string, string> = {
      agent_name:
        'SELECT DISTINCT agent_name FROM traces WHERE tenant_id = ? AND agent_name IS NOT NULL ORDER BY agent_name',
      framework:
        'SELECT DISTINCT framework FROM traces WHERE tenant_id = ? AND framework IS NOT NULL ORDER BY framework',
    };
    const query = queries[column];
    if (!query) {
      throw new Error(`Column '${column}' is not queryable (allowed: ${Object.keys(queries).join(', ')})`);
    }
    const rows = this.db.prepare(query).all(tenantId) as Array<Record<string, string>>;
    return rows.map((row) => row[column]);
  }

  private rowToTrace(row: Record<string, unknown>): Trace {
    return {
      trace_id: row.trace_id as string,
      agent_name: row.agent_name as string,
      framework: row.framework as string | undefined,
      input: row.input as string | undefined,
      output: row.output as string | undefined,
      tool_calls: row.tool_calls ? JSON.parse(row.tool_calls as string) : undefined,
      latency_ms: row.latency_ms as number | undefined,
      token_usage: row.token_usage ? JSON.parse(row.token_usage as string) : undefined,
      cost_usd: row.cost_usd as number | undefined,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
      timestamp: row.timestamp as string,
      created_at: row.created_at as string,
      tools: row.tools ? JSON.parse(row.tools as string) : undefined,
      run_id: (row.run_id as string | null) ?? undefined,
      case_key: (row.case_key as string | null) ?? undefined,
      ...(row.source != null ? { source: row.source as Trace['source'] } : {}),
    };
  }

  private rowToSpan(row: Record<string, unknown>): Span {
    return {
      span_id: row.span_id as string,
      trace_id: row.trace_id as string,
      parent_span_id: row.parent_span_id as string | undefined,
      name: row.name as string,
      kind: row.kind as Span['kind'],
      status_code: row.status_code as Span['status_code'],
      status_message: row.status_message as string | undefined,
      start_time: row.start_time as string,
      end_time: row.end_time as string | undefined,
      attributes: row.attributes ? JSON.parse(row.attributes as string) : undefined,
      events: row.events ? JSON.parse(row.events as string) : undefined,
    };
  }

  private rowToEvalResult(row: Record<string, unknown>): EvalResult {
    const result: EvalResult = {
      id: row.id as string,
      trace_id: row.trace_id as string | undefined,
      eval_type: row.eval_type as EvalResult['eval_type'],
      /*
       * `categories` is not a column: an eval_type="all" row carries a
       * `category` on every rule_results entry instead, so a reader can
       * regroup the per-bundle breakdown from what IS stored.
       */
      output_text: row.output_text as string,
      expected_text: (row.expected_text as string | null | undefined) ?? undefined,
      ...(row.erased_at ? { erased_at: row.erased_at as string } : {}),
      score: row.score as number,
      passed: (row.passed as number) === 1,
      rule_results: JSON.parse(row.rule_results as string),
      suggestions: JSON.parse(row.suggestions as string),
      created_at: row.created_at as string,
      rules_evaluated: row.rules_evaluated as number | undefined,
      rules_skipped: row.rules_skipped as number | undefined,
      insufficient_data: row.insufficient_data != null ? (row.insufficient_data as number) === 1 : undefined,
      /*
       * Absent, not [], when NULL. Rows written before migration 006 never
       * captured the field, and returning an empty array would assert "no
       * critical rule failed" about an evaluation that never recorded one.
       */
      ...(row.critical_failures != null
        ? { critical_failures: JSON.parse(row.critical_failures as string) as string[] }
        : {}),
      ...(row.eval_cost_usd != null ? { eval_cost_usd: row.eval_cost_usd as number } : {}),
      ...(row.eval_tokens != null ? { eval_tokens: row.eval_tokens as number } : {}),
      ...(row.provenance != null ? { provenance: JSON.parse(row.provenance as string) as Provenance } : {}),
    };
    /*
     * Derived on every read, never stored (0.9.0): the critical rules that
     * skipped (from the stamped flags — absent for rows older than those
     * flags, never []), the coverage by question, and the verdict with its
     * basis — the last only when the row carries the threshold it was judged
     * against, because a basis guessed against today's threshold would be a
     * fabrication about that day.
     */
    const criticalSkipped = deriveCriticalSkipped(result.rule_results);
    if (criticalSkipped) result.critical_skipped = criticalSkipped;
    if (result.rule_results.some((r) => r.question !== undefined)) result.coverage = deriveCoverage(result.rule_results);
    /*
     * Read back under the SAME composer facts that wrote it, or a stored row
     * would report a different verdict than the one the caller was given.
     * Until 0.13.0 the config was not stored (only its hash), so every read
     * re-composed under the shipped defaults — a deployment with its own
     * loss ratio saw one verdict on the tool and another on the dashboard.
     * provenance.composer now carries the three facts the composer needs;
     * a row written before it exists reads back under the defaults and
     * with an empty interpretations list — absent, never fabricated.
     */
    if (result.provenance) {
      const cfg = { ...DEFAULT_COMPOSE, ...(result.provenance.composer ?? {}) };
      result.verdict = compose(result, cfg);
      if (result.provenance.composer) {
        const notes = interpretations(result, result.verdict, cfg);
        if (notes.length > 0) result.interpretations = notes;
      }
    }
    return result;
  }
}
