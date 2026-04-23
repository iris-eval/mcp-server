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
import type {
  IStorageAdapter,
  DashboardSummary,
  TraceQueryOptions,
  TraceQueryResult,
  EvalStatsPeriod,
  EvalStats,
  EvalStatsTrendBucket,
  EvalStatsRuleBreakdown,
  EvalStatsFailure,
} from '../types/query.js';
import type { Trace, Span } from '../types/trace.js';
import type { EvalResult } from '../types/eval.js';
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

export class SqliteAdapter implements IStorageAdapter {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
  }

  async initialize(): Promise<void> {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    runMigrations(this.db);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async insertTrace(tenantId: TenantId, trace: Trace): Promise<void> {
    assertTenant(tenantId);
    const insertTraceStmt = this.db.prepare(`
      INSERT INTO traces (tenant_id, trace_id, agent_name, framework, input, output, tool_calls, latency_ms, token_usage, cost_usd, metadata, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    if (filter?.min_score !== undefined) {
      conditions.push(
        'EXISTS (SELECT 1 FROM eval_results e WHERE e.tenant_id = traces.tenant_id AND e.trace_id = traces.trace_id AND e.score >= ?)',
      );
      params.push(filter.min_score);
    }
    if (filter?.max_score !== undefined) {
      conditions.push(
        'EXISTS (SELECT 1 FROM eval_results e WHERE e.tenant_id = traces.tenant_id AND e.trace_id = traces.trace_id AND e.score <= ?)',
      );
      params.push(filter.max_score);
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
    this.db.prepare(`
      INSERT INTO eval_results (tenant_id, id, trace_id, eval_type, output_text, expected_text, score, passed, rule_results, suggestions, rules_evaluated, rules_skipped, insufficient_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tenantId,
      result.id,
      result.trace_id ?? null,
      result.eval_type,
      result.output_text,
      result.expected_text ?? null,
      result.score,
      result.passed ? 1 : 0,
      JSON.stringify(result.rule_results),
      JSON.stringify(result.suggestions),
      result.rules_evaluated ?? null,
      result.rules_skipped ?? null,
      result.insufficient_data ? 1 : 0,
    );
  }

  async getEvalsByTraceId(tenantId: TenantId, traceId: string): Promise<EvalResult[]> {
    assertTenant(tenantId);
    const rows = this.db
      .prepare('SELECT * FROM eval_results WHERE tenant_id = ? AND trace_id = ? ORDER BY created_at DESC')
      .all(tenantId, traceId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToEvalResult(row));
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

  private periodToSince(period: EvalStatsPeriod): string {
    if (period === 'all') return '1970-01-01T00:00:00.000Z';
    const hours = period === '24h' ? 24 : period === '7d' ? 168 : 720;
    return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  }

  async getEvalStats(tenantId: TenantId, period: EvalStatsPeriod): Promise<EvalStats> {
    assertTenant(tenantId);
    const since = this.periodToSince(period);

    const agg = this.db.prepare(`
      SELECT
        COUNT(*)                                     AS total_evals,
        COALESCE(AVG(score), 0)                      AS avg_score,
        SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS passed_count
      FROM eval_results
      WHERE tenant_id = ? AND created_at >= ? AND trace_id IS NOT NULL
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

    const safetyRows = this.db.prepare(`
      SELECT rule_results
      FROM eval_results
      WHERE tenant_id = ? AND created_at >= ?
        AND eval_type = 'safety'
        AND passed = 0
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

  async getEvalStatsTrend(tenantId: TenantId, period: EvalStatsPeriod): Promise<EvalStatsTrendBucket[]> {
    assertTenant(tenantId);
    const since = this.periodToSince(period);

    let bucketExpr: string;
    if (period === '24h') {
      bucketExpr = "strftime('%Y-%m-%dT%H:00:00Z', created_at)";
    } else if (period === '7d') {
      bucketExpr =
        "strftime('%Y-%m-%dT', created_at) || printf('%02d', (CAST(strftime('%H', created_at) AS INTEGER) / 6) * 6) || ':00:00Z'";
    } else {
      bucketExpr = "strftime('%Y-%m-%dT00:00:00Z', created_at)";
    }

    const rows = this.db.prepare(`
      SELECT
        ${bucketExpr}                                  AS bucket,
        COALESCE(AVG(score), 0)                        AS avg_score,
        CASE WHEN COUNT(*) > 0
          THEN CAST(SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*)
          ELSE 0 END                                   AS pass_rate,
        COUNT(*)                                       AS eval_count
      FROM eval_results
      WHERE tenant_id = ? AND created_at >= ?
      GROUP BY bucket
      ORDER BY bucket
    `).all(tenantId, since) as Array<{
      bucket: string;
      avg_score: number;
      pass_rate: number;
      eval_count: number;
    }>;

    return rows.map((r) => ({
      timestamp: r.bucket,
      avgScore: Math.round(r.avg_score * 1000) / 1000,
      passRate: Math.round(r.pass_rate * 1000) / 1000,
      evalCount: r.eval_count,
    }));
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
    const result = this.db
      .prepare('DELETE FROM traces WHERE tenant_id = ? AND timestamp < ?')
      .run(tenantId, cutoff);
    return result.changes;
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
    return {
      id: row.id as string,
      trace_id: row.trace_id as string | undefined,
      eval_type: row.eval_type as EvalResult['eval_type'],
      output_text: row.output_text as string,
      expected_text: row.expected_text as string | undefined,
      score: row.score as number,
      passed: (row.passed as number) === 1,
      rule_results: JSON.parse(row.rule_results as string),
      suggestions: JSON.parse(row.suggestions as string),
      created_at: row.created_at as string,
      rules_evaluated: row.rules_evaluated as number | undefined,
      rules_skipped: row.rules_skipped as number | undefined,
      insufficient_data: row.insufficient_data != null ? (row.insufficient_data as number) === 1 : undefined,
    };
  }
}
