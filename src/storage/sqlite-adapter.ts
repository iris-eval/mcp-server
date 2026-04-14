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
import { runMigrations } from './migrations/index.js';

const ALLOWED_SORT_COLUMNS = new Set(['timestamp', 'latency_ms', 'cost_usd']);
const ALLOWED_SORT_ORDERS = new Set(['asc', 'desc']);

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

  async insertTrace(trace: Trace): Promise<void> {
    const insertTraceStmt = this.db.prepare(`
      INSERT INTO traces (trace_id, agent_name, framework, input, output, tool_calls, latency_ms, token_usage, cost_usd, metadata, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSpanStmt = this.db.prepare(`
      INSERT INTO spans (span_id, trace_id, parent_span_id, name, kind, status_code, status_message, start_time, end_time, attributes, events)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertAll = this.db.transaction((t: Trace) => {
      insertTraceStmt.run(
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

  async getTrace(traceId: string): Promise<Trace | null> {
    const row = this.db.prepare('SELECT * FROM traces WHERE trace_id = ?').get(traceId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToTrace(row);
  }

  async queryTraces(options: TraceQueryOptions): Promise<TraceQueryResult> {
    const conditions: string[] = [];
    const params: unknown[] = [];
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

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sortBy = options.sort_by ?? 'timestamp';
    const sortOrder = options.sort_order ?? 'desc';

    if (!ALLOWED_SORT_COLUMNS.has(sortBy)) {
      throw new Error(`Invalid sort column: ${sortBy}`);
    }
    if (!ALLOWED_SORT_ORDERS.has(sortOrder)) {
      throw new Error(`Invalid sort order: ${sortOrder}`);
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

  async insertSpan(span: Span): Promise<void> {
    this.db.prepare(`
      INSERT INTO spans (span_id, trace_id, parent_span_id, name, kind, status_code, status_message, start_time, end_time, attributes, events)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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

  async getSpansByTraceId(traceId: string): Promise<Span[]> {
    const rows = this.db
      .prepare('SELECT * FROM spans WHERE trace_id = ? ORDER BY start_time')
      .all(traceId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToSpan(row));
  }

  async insertEvalResult(result: EvalResult): Promise<void> {
    this.db.prepare(`
      INSERT INTO eval_results (id, trace_id, eval_type, output_text, expected_text, score, passed, rule_results, suggestions)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.id,
      result.trace_id ?? null,
      result.eval_type,
      result.output_text,
      result.expected_text ?? null,
      result.score,
      result.passed ? 1 : 0,
      JSON.stringify(result.rule_results),
      JSON.stringify(result.suggestions),
    );
  }

  async getEvalsByTraceId(traceId: string): Promise<EvalResult[]> {
    const rows = this.db
      .prepare('SELECT * FROM eval_results WHERE trace_id = ? ORDER BY created_at DESC')
      .all(traceId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToEvalResult(row));
  }

  async queryEvalResults(options: {
    eval_type?: string;
    passed?: boolean;
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ results: EvalResult[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];

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

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
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

  async getDashboardSummary(sinceHours = 24): Promise<DashboardSummary> {
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();

    const stats = this.db.prepare(`
      SELECT
        COUNT(*) as total_traces,
        COALESCE(AVG(latency_ms), 0) as avg_latency_ms,
        COALESCE(SUM(cost_usd), 0) as total_cost_usd
      FROM traces WHERE timestamp >= ?
    `).get(since) as { total_traces: number; avg_latency_ms: number; total_cost_usd: number };

    const errorCount = this.db.prepare(`
      SELECT COUNT(DISTINCT t.trace_id) as count
      FROM traces t
      JOIN spans s ON s.trace_id = t.trace_id
      WHERE t.timestamp >= ? AND s.status_code = 'ERROR'
    `).get(since) as { count: number };

    const evalStats = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) as passed_count
      FROM eval_results WHERE created_at >= ?
    `).get(since) as { total: number; passed_count: number };

    const tracesPerHour = this.db.prepare(`
      SELECT strftime('%Y-%m-%dT%H:00:00', timestamp) as hour, COUNT(*) as count
      FROM traces WHERE timestamp >= ?
      GROUP BY hour ORDER BY hour
    `).all(since) as Array<{ hour: string; count: number }>;

    const topAgents = this.db.prepare(`
      SELECT agent_name, COUNT(*) as count
      FROM traces WHERE timestamp >= ?
      GROUP BY agent_name ORDER BY count DESC LIMIT 10
    `).all(since) as Array<{ agent_name: string; count: number }>;

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

  async getEvalStats(period: EvalStatsPeriod): Promise<EvalStats> {
    const since = this.periodToSince(period);

    const agg = this.db.prepare(`
      SELECT
        COUNT(*)                                     AS total_evals,
        COALESCE(AVG(score), 0)                      AS avg_score,
        SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS passed_count
      FROM eval_results
      WHERE created_at >= ? AND trace_id IS NOT NULL
    `).get(since) as { total_evals: number; avg_score: number; passed_count: number };

    const cost = this.db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS total_cost
      FROM traces
      WHERE timestamp >= ?
    `).get(since) as { total_cost: number };

    const agents = this.db.prepare(`
      SELECT COUNT(DISTINCT agent_name) AS agent_count
      FROM traces
      WHERE timestamp >= ?
    `).get(since) as { agent_count: number };

    // Safety violations — scan rule_results JSON for failing safety rules.
    // rule_results is stored as a JSON array of EvalRuleResult objects.
    const safetyRows = this.db.prepare(`
      SELECT rule_results
      FROM eval_results
      WHERE created_at >= ?
        AND eval_type = 'safety'
        AND passed = 0
    `).all(since) as Array<{ rule_results: string }>;

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

  async getEvalStatsTrend(period: EvalStatsPeriod): Promise<EvalStatsTrendBucket[]> {
    const since = this.periodToSince(period);

    // Determine bucket format for strftime
    let bucketExpr: string;
    if (period === '24h') {
      // hourly buckets
      bucketExpr = "strftime('%Y-%m-%dT%H:00:00Z', created_at)";
    } else if (period === '7d') {
      // 6-hour buckets: floor hour to nearest 6
      bucketExpr =
        "strftime('%Y-%m-%dT', created_at) || printf('%02d', (CAST(strftime('%H', created_at) AS INTEGER) / 6) * 6) || ':00:00Z'";
    } else {
      // daily buckets
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
      WHERE created_at >= ?
      GROUP BY bucket
      ORDER BY bucket
    `).all(since) as Array<{
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

  async getEvalStatsRules(period: EvalStatsPeriod): Promise<EvalStatsRuleBreakdown[]> {
    const since = this.periodToSince(period);

    const rows = this.db.prepare(`
      SELECT rule_results
      FROM eval_results
      WHERE created_at >= ?
    `).all(since) as Array<{ rule_results: string }>;

    // Aggregate per-rule stats from the JSON arrays
    const ruleMap = new Map<string, { totalRun: number; failCount: number }>();

    for (const row of rows) {
      const rules: Array<{ ruleName: string; passed: boolean }> = JSON.parse(row.rule_results);
      for (const r of rules) {
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

    // Sort by passRate ASC (worst rules first)
    result.sort((a, b) => a.passRate - b.passRate);

    return result;
  }

  async getEvalStatsFailures(period: EvalStatsPeriod, limit: number): Promise<EvalStatsFailure[]> {
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
      LEFT JOIN traces t ON t.trace_id = e.trace_id
      WHERE e.created_at >= ?
        AND e.passed = 0
      ORDER BY e.created_at DESC
      LIMIT ?
    `).all(since, limit) as Array<{
      trace_id: string | null;
      agent_name: string;
      rule_results: string;
      score: number;
      output_text: string;
      created_at: string;
    }>;

    return rows.map((r) => {
      // Find the first failing rule to surface as the primary rule
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

  async deleteTracesOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare('DELETE FROM traces WHERE timestamp < ?').run(cutoff);
    return result.changes;
  }

  async getDistinctValues(column: string): Promise<string[]> {
    const queries: Record<string, string> = {
      agent_name: 'SELECT DISTINCT agent_name FROM traces WHERE agent_name IS NOT NULL ORDER BY agent_name',
      framework: 'SELECT DISTINCT framework FROM traces WHERE framework IS NOT NULL ORDER BY framework',
    };
    const query = queries[column];
    if (!query) {
      throw new Error(`Column '${column}' is not queryable`);
    }
    const rows = this.db.prepare(query).all() as Array<Record<string, string>>;
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
    };
  }
}
