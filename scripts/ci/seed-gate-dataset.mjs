/*
 * Seed the dataset the dogfood gate reads: `release-gate`
 * with the two case keys the walk-through gates (`deploy-config`,
 * `release-notes`), written straight into the database under IRIS_HOME
 * through the built adapter — the same rows `POST /api/v1/datasets`
 * would write, without a server. Run after `npm run build`.
 *
 *   IRIS_HOME=/tmp/iris node scripts/ci/seed-gate-dataset.mjs
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteAdapter } from '../../dist/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../dist/types/tenant.js';

const home = process.env.IRIS_HOME;
if (!home) {
  process.stderr.write('seed-gate-dataset: set IRIS_HOME\n');
  process.exit(2);
}
mkdirSync(home, { recursive: true });
const storage = new SqliteAdapter(join(home, 'iris.db'));
await storage.initialize();
try {
  const existing = await storage.getDataset(LOCAL_TENANT, 'release-gate');
  if (existing) {
    process.stdout.write(`seed-gate-dataset: release-gate exists (${existing.id})\n`);
  } else {
    const created = await storage.createDataset(LOCAL_TENANT, {
      label: 'release-gate',
      cases: [
        { caseKey: 'deploy-config', expected: null },
        { caseKey: 'release-notes', expected: null },
      ],
    });
    process.stdout.write(`seed-gate-dataset: release-gate created (${created.id}, ${created.cases} cases)\n`);
  }
} finally {
  await storage.close();
}
