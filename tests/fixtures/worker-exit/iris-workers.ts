/*
 * Iris's own worker threads, started and ended again and again, every way
 * each ends in the product. Run with tsx; prints "done" when nothing took
 * the process down.
 *
 *   npx tsx iris-workers.ts <native|node> <ending> <cycles>      (WORKER_EXIT_FROM=dist: the built server)
 *
 * Endings:
 *   store             a store opens, a write starts its checkpoint worker and a search its search
 *                     worker, and the store closes: each thread closes its own connection and ends
 *   search-stuck      a search judged stuck as it starts (no budget, no grace): its thread is terminated
 *                     wherever it is, a statement calling the search's JS function included
 *   checkpoint-crash  the checkpoint thread stops after it was ready (terminated with its connection
 *                     open, mid-checkpoint when one is running), and the store's next write replaces it
 *   checkpoint-kill   the checkpoint thread is terminated while it runs a TRUNCATE checkpoint, as
 *                     close() does to a thread that has not ended in 5 s
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * From the sources (tsx), as the test suite runs it, the search thread
 * registers tsx's loader before it loads search-worker.ts. From the build
 * (WORKER_EXIT_FROM=dist, after npm run build), as an installed server runs
 * it, the thread loads search-worker.js with no loader.
 */
const base = process.env.WORKER_EXIT_FROM === 'dist' ? '../../../dist/' : '../../../src/';
const ext = process.env.WORKER_EXIT_FROM === 'dist' ? '.js' : '.ts';
const { SqliteAdapter } = (await import(`${base}storage/sqlite-adapter${ext}`)) as typeof import('../../../src/storage/sqlite-adapter.js');
const { SearchWorkerClient } = (await import(`${base}storage/search-worker-client${ext}`)) as typeof import('../../../src/storage/search-worker-client.js');
const { Checkpointer } = (await import(`${base}storage/checkpointer${ext}`)) as typeof import('../../../src/storage/checkpointer.js');
const { parseSearch } = (await import(`${base}storage/search${ext}`)) as typeof import('../../../src/storage/search.js');
const { LOCAL_TENANT } = (await import(`${base}types/tenant${ext}`)) as typeof import('../../../src/types/tenant.js');

type Ending = 'store' | 'search-stuck' | 'checkpoint-crash' | 'checkpoint-kill';
const [driver, ending, cyclesArg] = process.argv.slice(2) as ['native' | 'node', Ending, string];
const cycles = Number(cyclesArg);
const dir = mkdtempSync(join(tmpdir(), 'iris-worker-cycles-'));
const path = join(dir, 'iris.db');

const trace = (i: number) => ({
  trace_id: `t-${i}`,
  agent_name: 'support-bot',
  input: `question ${i} about an order and its refund`,
  output: `${i % 7 === 0 ? 'the refund was approved' : 'the order ships tomorrow'} — reply ${i} w${i}x`,
  timestamp: new Date(Date.now() - i * 1000).toISOString(),
});

const seed = new SqliteAdapter(path, { driver, searchWorker: false });
await seed.initialize();
await seed.insertTraces(LOCAL_TENANT, Array.from({ length: 2000 }, (_, i) => trace(i)));
await seed.whenSearchIndexReady();
await seed.close();

const plan = { whereClause: 'WHERE tenant_id = ?', params: ['local'], filtered: false, sortBy: 'relevance', sortOrder: 'desc', limit: 50, offset: 0 };
const threadOf = (c: unknown) => (c as { worker: { terminate(): Promise<number>; ref(): void } }).worker;
/**
 * Terminate a store's thread as the Checkpointer's own close does: referenced first. The
 * checkpointer unreferences an idle thread so it never holds a process open; a thread still in
 * a native statement ends only when the statement returns, and meanwhile an unreferenced thread
 * leaves the event loop empty, so the process exits 13 with this await unsettled (macOS, Node
 * 24, 1 process in 10) instead of waiting for the thread to end.
 */
async function terminated(worker: { terminate(): Promise<number>; ref(): void }): Promise<void> {
  worker.ref();
  await worker.terminate();
}
// The workers are unref'd, as in the product; a timer holds this script open while it waits for one to be ready.
const held = async <T>(p: Promise<T>): Promise<T> => {
  const t = setInterval(() => undefined, 1000);
  try {
    return await p;
  } finally {
    clearInterval(t);
  }
};
const driverName = driver === 'node' ? 'node' : 'better-sqlite3';
let next = 2000;

for (let i = 0; i < cycles; i++) {
  if (ending === 'store') {
    const store = new SqliteAdapter(path, { driver });
    await store.initialize();
    await store.insertTrace(LOCAL_TENANT, trace(next++));
    const r = await store.queryTraces(LOCAL_TENANT, { search: 'refund approved', limit: 5, offset: 0 });
    if (r.total === 0) throw new Error('the search found nothing');
    await store.close();
  } else if (ending === 'search-stuck') {
    const client = new SearchWorkerClient({ path, driver, busyTimeoutMs: 5000 }, 0);
    await client.search({ tenantId: 'local', parsed: parseSearch(i % 2 ? 'refund' : 'w1x'), plan, index: i % 2 ? 'fts5' : 'scan', budgetMs: 0 } as never);
    await client.close();
  } else if (ending === 'checkpoint-crash') {
    // The adapter's own recovery: after a crash, its next write starts a new thread.
    const store = new SqliteAdapter(path, { driver, searchWorker: false });
    await store.initialize();
    await store.insertTrace(LOCAL_TENANT, trace(next++));
    const first = (store as unknown as { checkpointer?: InstanceType<typeof Checkpointer> }).checkpointer;
    if (!first || !(await held(first.started))) throw new Error('the checkpoint worker did not start');
    await terminated(threadOf(first));
    await store.insertTrace(LOCAL_TENANT, trace(next++));
    const second = (store as unknown as { checkpointer?: InstanceType<typeof Checkpointer> }).checkpointer;
    if (!second || second === first || !(await held(second.started))) throw new Error('the crashed checkpoint worker was not replaced');
    await store.close();
  } else {
    const cp = new Checkpointer({ path, driver: driverName, busyMs: 5000, onReady: () => undefined, onFailed: () => undefined });
    if (!(await held(cp.started))) throw new Error('the checkpoint worker did not start');
    void cp.truncate().catch(() => undefined);
    await terminated(threadOf(cp));
    await cp.close();
  }
}
rmSync(dir, { recursive: true, force: true });
process.stdout.write('done\n');
