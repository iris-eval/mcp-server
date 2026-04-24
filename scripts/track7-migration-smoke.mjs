#!/usr/bin/env node
// Track 7 — real-DB v0.3 → v0.4 migration smoke
//
// Safely verifies that opening a production v0.3.x ~/.iris/iris.db with
// v0.4 code applies migration 004 correctly. Never touches the original:
// copy → open → assert → log → delete copy.
//
// Runs against the v0.4 compiled adapter in ./dist, so we're testing
// the actual release artifact, not a re-implementation.

import { cpSync, statSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SqliteAdapter } from '../dist/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../dist/types/tenant.js';

const realDb = join(homedir(), '.iris', 'iris.db');
if (!existsSync(realDb)) {
  console.error(`FATAL: ${realDb} does not exist`);
  process.exit(1);
}
const originalSize = statSync(realDb).size;
console.log(`Source: ${realDb} (${originalSize} bytes, mtime ${statSync(realDb).mtime.toISOString()})`);

const copyPath = join(tmpdir(), `iris-track7-${Date.now()}.db`);
cpSync(realDb, copyPath);
console.log(`Copied to: ${copyPath}`);

// --- Step 1: pre-migration schema snapshot ---
const preDb = new Database(copyPath, { readonly: true });
const preTables = preDb.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
let preCounts = {};
for (const t of preTables) {
  try {
    preCounts[t] = preDb.prepare(`SELECT COUNT(*) as c FROM "${t}"`).get().c;
  } catch {}
}
console.log('Pre-migration tables:', preTables.join(', '));
console.log('Pre-migration counts:', preCounts);

// Check if tenant_id column already exists (it shouldn't on pre-v0.4)
const preTraceCols = preDb.prepare('PRAGMA table_info(traces)').all().map((r) => r.name);
const hadTenantIdBeforeMigration = preTraceCols.includes('tenant_id');
console.log(`Pre-migration traces has tenant_id column: ${hadTenantIdBeforeMigration}`);
preDb.close();

// --- Step 2: open with v0.4 adapter (triggers migration) ---
console.log('\nOpening with v0.4 adapter ...');
const adapter = new SqliteAdapter(copyPath);
await adapter.initialize();

// --- Step 3: post-migration assertions ---
const postDb = new Database(copyPath, { readonly: true });
const postTraceCols = postDb.prepare('PRAGMA table_info(traces)').all().map((r) => r.name);
const traceCol = postDb.prepare('PRAGMA table_info(traces)').all().find((r) => r.name === 'tenant_id');
console.log('Post-migration traces columns:', postTraceCols.join(', '));
const assertions = [];

// A. tenant_id column exists + NOT NULL + default 'local'
assertions.push({
  name: 'tenant_id column added to traces',
  pass: postTraceCols.includes('tenant_id'),
});
assertions.push({
  name: 'tenant_id is NOT NULL',
  pass: traceCol?.notnull === 1,
});
assertions.push({
  name: "tenant_id default is 'local'",
  pass: (traceCol?.dflt_value ?? '').replaceAll("'", '') === 'local',
});

// B. Existing rows backfilled with tenant_id='local'
const distinctTenants = postDb.prepare("SELECT DISTINCT tenant_id FROM traces").all().map((r) => r.tenant_id);
console.log('Distinct tenant_id values in traces:', distinctTenants);
assertions.push({
  name: 'All existing traces backfilled to local tenant',
  pass: distinctTenants.length === 1 && distinctTenants[0] === LOCAL_TENANT,
});

// C. Row count unchanged vs pre-migration
const postTraceCount = postDb.prepare('SELECT COUNT(*) as c FROM traces').get().c;
assertions.push({
  name: `No data loss: trace count ${preCounts.traces} → ${postTraceCount}`,
  pass: postTraceCount === preCounts.traces,
});

// D. Same for eval_results
if (preCounts.eval_results !== undefined) {
  const postEvalCount = postDb.prepare('SELECT COUNT(*) as c FROM eval_results').get().c;
  assertions.push({
    name: `No data loss: eval_results ${preCounts.eval_results} → ${postEvalCount}`,
    pass: postEvalCount === preCounts.eval_results,
  });
  const evalTenants = postDb.prepare("SELECT DISTINCT tenant_id FROM eval_results").all().map((r) => r.tenant_id);
  assertions.push({
    name: 'All existing eval_results backfilled to local tenant',
    pass: evalTenants.length === 1 && evalTenants[0] === LOCAL_TENANT,
  });
}

// E. Composite (tenant_id, *) indexes present
const indexes = postDb.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all().map((r) => r.name);
const tenantIndexes = indexes.filter((n) => n.includes('tenant'));
console.log('Tenant-scoped indexes:', tenantIndexes.join(', ') || '(none)');
assertions.push({
  name: 'At least one tenant-composite index exists',
  pass: tenantIndexes.length > 0,
});

// F. Migrations table has 004 applied
const migrations = postDb.prepare("SELECT id FROM _iris_migrations ORDER BY id").all().map((r) => r.id);
console.log('Applied migrations:', migrations);
assertions.push({
  name: 'Migration 004 applied (id contains "004")',
  pass: migrations.some((id) => String(id).includes('004')),
});

postDb.close();

// --- Step 4: live queries via adapter (tenant-scoped) ---
console.log('\nLive queries via adapter:');
const sampleTraces = await adapter.queryTraces(LOCAL_TENANT, {});
console.log(`  adapter.queryTraces(LOCAL_TENANT): ${sampleTraces.total} total`);
assertions.push({
  name: 'adapter.queryTraces returns existing data under local tenant',
  pass: sampleTraces.total === preCounts.traces,
});

if (sampleTraces.traces.length > 0) {
  const firstId = sampleTraces.traces[0].trace_id;
  const detail = await adapter.getTrace(LOCAL_TENANT, firstId);
  assertions.push({
    name: `adapter.getTrace returns detail for ${firstId.slice(0, 12)}...`,
    pass: detail !== null && detail.trace_id === firstId,
  });
  // Cross-tenant isolation
  const otherTenant = await adapter.getTrace('other-tenant-id', firstId);
  assertions.push({
    name: 'Cross-tenant isolation: same id under different tenant returns null',
    pass: otherTenant === null,
  });
}

// --- Step 5: idempotency — re-open with another adapter instance ---
console.log('\nRe-opening to test migration idempotency ...');
await adapter.close();
const adapter2 = new SqliteAdapter(copyPath);
await adapter2.initialize();
const postMigration = migrations.includes(4);
const rerunDb = new Database(copyPath, { readonly: true });
const migrations2 = rerunDb.prepare('SELECT COUNT(*) as c FROM _iris_migrations').get().c;
rerunDb.close();
assertions.push({
  name: 'Re-opening does not duplicate migrations',
  pass: migrations2 === migrations.length,
});
await adapter2.close();

// --- Step 6: original file untouched ---
const originalSizeAfter = statSync(realDb).size;
assertions.push({
  name: 'Original ~/.iris/iris.db untouched',
  pass: originalSizeAfter === originalSize,
});

// --- Step 7: cleanup copy ---
unlinkSync(copyPath);
console.log(`Cleanup: ${copyPath} removed`);

// --- Report ---
console.log('\n=== Results ===');
let failed = 0;
for (const a of assertions) {
  console.log(`  ${a.pass ? '✓' : '✗'} ${a.name}`);
  if (!a.pass) failed++;
}
console.log(`\n${assertions.length - failed}/${assertions.length} assertions passed`);
if (failed > 0) process.exit(1);
