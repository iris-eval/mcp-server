/**
 * Seed Demo Data — CLI wrapper around the product seeder
 * (src/dashboard/seed-demo-data.ts, the same code `iris-mcp --demo` runs).
 *
 * Usage:
 *   npx tsx scripts/seed-demo-data.ts [--db-path <path>] [--clean] [--count <n>]
 *
 * Flags:
 *   --db-path <path>   Database file path (default: demo.db under IRIS_HOME or ~/.iris)
 *   --clean            Delete the existing database file before seeding
 *   --count <n>        Approximate number of traces to generate (default: 250)
 *
 * Seeding is idempotent: a database that already holds traces is left
 * untouched unless --clean is passed. Always QUOTE Windows paths in shell
 * commands — `--db-path C:\Users\you\.iris\demo.db` unquoted in bash
 * mangles the backslashes and creates a stray `C:Usersyou...` file.
 */

import { parseArgs } from 'node:util';
import { existsSync, unlinkSync } from 'node:fs';
import {
  seedDemoData,
  demoDbPath,
  DEFAULT_DEMO_TRACE_COUNT,
} from '../src/dashboard/seed-demo-data.js';

const { values } = parseArgs({
  options: {
    'db-path': { type: 'string' },
    'clean': { type: 'boolean', default: false },
    'count': { type: 'string' },
  },
  strict: false,
});

const dbPath = (values['db-path'] as string | undefined) ?? demoDbPath();
const shouldClean = (values['clean'] as boolean | undefined) ?? false;
const targetTraceCount = parseInt((values['count'] as string | undefined) ?? String(DEFAULT_DEMO_TRACE_COUNT), 10);

async function main(): Promise<void> {
  if (shouldClean) {
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(path)) {
        unlinkSync(path);
        process.stderr.write(`Cleaned: "${path}"\n`);
      }
    }
  }

  const summary = await seedDemoData({ dbPath, count: targetTraceCount });

  if (summary.alreadySeeded) {
    process.stderr.write(
      `\nDemo database already seeded (${summary.traceCount} traces, ${summary.evalCount} evaluations) — left untouched.\n` +
        `Re-run with --clean to reseed from scratch.\n\n` +
        `  Database: "${summary.dbPath}"\n\n`,
    );
    return;
  }

  const passRate = summary.evalCount > 0 ? ((summary.passedEvalCount / summary.evalCount) * 100).toFixed(1) : 'N/A';

  process.stderr.write(`\n${'='.repeat(60)}\n`);
  process.stderr.write(`  Iris Demo Data Seeded Successfully\n`);
  process.stderr.write(`${'='.repeat(60)}\n\n`);

  process.stderr.write(`  Database:     "${summary.dbPath}"\n`);
  process.stderr.write(`  Traces:       ${summary.traceCount}\n`);
  process.stderr.write(`  Spans:        ${summary.spanCount}\n`);
  process.stderr.write(`  Evaluations:  ${summary.evalCount}\n`);
  process.stderr.write(`  Total cost:   $${summary.totalCostUsd.toFixed(2)}\n\n`);

  process.stderr.write(`  Eval Summary:\n`);
  process.stderr.write(`    Passed:     ${summary.passedEvalCount} (${passRate}%)\n`);
  process.stderr.write(`    Failed:     ${summary.failedEvalCount}\n\n`);

  process.stderr.write(`  Failures worth clicking into:\n`);
  process.stderr.write(`    PII detections:       ${summary.piiDetectionCount}\n`);
  process.stderr.write(`    Injection patterns:   ${summary.injectionDetectionCount}\n`);
  process.stderr.write(`    Hallucination flags:  ${summary.hallucinationDetectionCount}\n`);
  process.stderr.write(`    Cost violations:      ${summary.costViolationCount}\n`);
  process.stderr.write(`    Failed judge scores:  ${summary.judgeFailureCount}\n\n`);

  process.stderr.write(`  Agents:\n`);
  for (const agent of summary.agents) {
    const rate = agent.evalPassRatePct === null ? 'N/A' : `${agent.evalPassRatePct}%`;
    process.stderr.write(
      `    ${agent.name.padEnd(20)} ${String(agent.traceCount).padStart(4)} traces  ${rate} pass rate\n`,
    );
  }

  process.stderr.write(`\n  Daily Distribution:\n`);
  summary.dailyTraceCounts.forEach((count, d) => {
    const dayLabel = d === 6 ? 'today' : d === 5 ? 'yesterday' : `${6 - d} days ago`;
    const bar = '#'.repeat(Math.round(count / 2));
    process.stderr.write(`    Day ${d + 1} (${dayLabel.padEnd(11)}) ${String(count).padStart(3)} ${bar}\n`);
  });

  process.stderr.write(`\n  Start the dashboard (quote the path — required on Windows):\n`);
  process.stderr.write(`    npx tsx src/index.ts --transport http --dashboard --db-path "${dbPath}"\n\n`);
  process.stderr.write(`  Or, for the default demo path, just:\n`);
  process.stderr.write(`    npx tsx src/index.ts --demo\n\n`);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err}\n`);
  if (err instanceof Error) process.stderr.write(`Stack: ${err.stack}\n`);
  process.exit(1);
});
