import type Database from 'better-sqlite3';

export const id = '001-initial-schema';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS traces (
      trace_id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      framework TEXT,
      input TEXT,
      output TEXT,
      tool_calls TEXT,
      latency_ms REAL,
      token_usage TEXT,
      cost_usd REAL,
      metadata TEXT,
      timestamp TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_traces_agent_name ON traces(agent_name);
    CREATE INDEX IF NOT EXISTS idx_traces_timestamp ON traces(timestamp);
    CREATE INDEX IF NOT EXISTS idx_traces_framework ON traces(framework);

    CREATE TABLE IF NOT EXISTS spans (
      span_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL REFERENCES traces(trace_id) ON DELETE CASCADE,
      parent_span_id TEXT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'INTERNAL',
      status_code TEXT NOT NULL DEFAULT 'UNSET',
      status_message TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT,
      attributes TEXT,
      events TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_spans_trace_id ON spans(trace_id);
    CREATE INDEX IF NOT EXISTS idx_spans_parent ON spans(parent_span_id);

    CREATE TABLE IF NOT EXISTS eval_results (
      id TEXT PRIMARY KEY,
      trace_id TEXT REFERENCES traces(trace_id) ON DELETE SET NULL,
      eval_type TEXT NOT NULL,
      output_text TEXT NOT NULL,
      expected_text TEXT,
      score REAL NOT NULL,
      passed INTEGER NOT NULL,
      rule_results TEXT,
      suggestions TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_eval_results_trace_id ON eval_results(trace_id);
    CREATE INDEX IF NOT EXISTS idx_eval_results_eval_type ON eval_results(eval_type);
    CREATE INDEX IF NOT EXISTS idx_eval_results_created_at ON eval_results(created_at);
  `);
}
