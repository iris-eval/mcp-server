#!/usr/bin/env node
// Seed a fresh SQLite DB with enough data for Track 6 dashboard walks.
// Produces a clean, deterministic dataset at the given path.
// Usage: node scripts/seed-track6-db.mjs <dbPath>

import { SqliteAdapter } from '../dist/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../dist/types/tenant.js';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('usage: seed-track6-db.mjs <dbPath>');
  process.exit(2);
}

const storage = new SqliteAdapter(dbPath);
await storage.initialize();

// Deterministic timestamps — 7 days of traces, 3 per day.
const NOW = new Date('2026-04-24T18:00:00Z').getTime();
const DAY = 86_400_000;

const agents = ['code-review-agent', 'rag-research-agent', 'support-classifier'];
const frameworks = ['langchain', 'crewai', 'mcp-sdk'];

let traceCount = 0;
let evalCount = 0;

for (let d = 6; d >= 0; d--) {
  for (let h = 0; h < 3; h++) {
    const ts = new Date(NOW - d * DAY - h * 3_600_000).toISOString();
    const agentIdx = (d + h) % agents.length;
    const traceId = `trace-${String(++traceCount).padStart(2, '0').repeat(8)}`.slice(0, 32);
    const costUsd = 0.005 + (d + h) * 0.0012;
    const outputQuality = d < 2 ? 0.85 : 0.65 + (d % 3) * 0.08;

    await storage.insertTrace(LOCAL_TENANT, {
      trace_id: traceId,
      agent_name: agents[agentIdx],
      framework: frameworks[agentIdx],
      input: `Sample input #${traceCount} for ${agents[agentIdx]}`,
      output: `Sample output #${traceCount} — response body of varying quality for evaluation.`,
      latency_ms: 500 + (traceCount * 37) % 2000,
      cost_usd: costUsd,
      token_usage: {
        prompt_tokens: 500 + (traceCount * 11) % 1500,
        completion_tokens: 100 + (traceCount * 13) % 800,
        total_tokens: 600 + (traceCount * 23) % 2300,
      },
      tool_calls: [{ tool_name: 'web_search', latency_ms: 120 }, { tool_name: 'fs_read', latency_ms: 18 }],
      metadata: { env: 'test', request_id: `req-${traceCount}` },
      timestamp: ts,
    });

    // Two evals per trace — one pass, one fail-ish
    const evalTypes = ['completeness', 'safety'];
    for (const evalType of evalTypes) {
      const score = evalType === 'safety' ? outputQuality : Math.max(0.2, outputQuality - 0.15);
      const passed = score >= 0.7;
      const evalId = `eval-${String(++evalCount).padStart(2, '0').repeat(8)}`.slice(0, 32);
      await storage.insertEvalResult(LOCAL_TENANT, {
        id: evalId,
        trace_id: traceId,
        eval_type: evalType,
        output_text: `Sample output #${traceCount}`,
        score: Math.round(score * 1000) / 1000,
        passed,
        rule_results: [
          {
            ruleName: evalType === 'safety' ? 'no_pii' : 'min_output_length',
            passed,
            score,
            message: passed ? 'OK' : `${evalType} below threshold`,
          },
        ],
        suggestions: passed ? [] : [`Improve ${evalType}`],
        rules_evaluated: 1,
        rules_skipped: 0,
        insufficient_data: false,
        created_at: ts,
      });
    }
  }
}

// Seed an audit log entry so the audit surface isn't empty.
try {
  const { appendAuditEntry } = await import('../dist/audit-log.js');
  appendAuditEntry({
    action: 'deploy',
    ruleId: 'seeded-rule-1',
    ruleName: 'min-output-length-40',
    description: 'Track 6 seeded audit entry — verifying audit log UI renders',
    tenantId: LOCAL_TENANT,
    actor: 'seed-track6',
  });
} catch (err) {
  console.warn('audit log seeding skipped:', err.message);
}

console.log(`Seeded ${traceCount} traces + ${evalCount} evals into ${dbPath}`);
await storage.close();
