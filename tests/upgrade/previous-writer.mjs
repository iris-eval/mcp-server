// Writes into a database with a released Iris's own storage adapter, in a
// process of its own (its native SQLite module is then never loaded into the
// test runner, where Windows would keep the file locked).
//
//   node previous-writer.mjs <package dir> <database> <estimated trace id>
//
// Prints one JSON line with what each call returned.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [pkg, file, estimatedId] = process.argv.slice(2);
const { SqliteAdapter } = await import(pathToFileURL(join(pkg, 'dist', 'storage', 'sqlite-adapter.js')).href);
const now = new Date().toISOString();
const store = new SqliteAdapter(file);
await store.initialize();
await store.insertTraces('local', [
  { trace_id: 'r0000000000000000000000000000001', agent_name: 'old', input: 'q', output: 'reported walrus', cost_usd: 0.5, timestamp: now },
  { trace_id: 'n0000000000000000000000000000001', agent_name: 'old', input: 'q', output: 'costless narwhal', timestamp: now },
  { trace_id: 'x0000000000000000000000000000001', agent_name: 'old', input: 'q', output: 'expired axolotl', cost_usd: 1, timestamp: '2020-01-01T00:00:00.000Z' },
]);
const patched = await store.updateTraceMetadata('local', estimatedId, { patched: 'by the previous release' });
const deleted = await store.deleteTrace('local', '0190a000000000000000000000000001');
const swept = await store.deleteTracesOlderThan('local', 30);
await store.close();
process.stdout.write(`${JSON.stringify({ patched, deleted, swept })}\n`);
