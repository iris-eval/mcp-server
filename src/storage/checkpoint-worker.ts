/*
 * The checkpoint worker's thread (checkpointer.ts starts it and talks to
 * it). It holds its own connection to the store, opened through
 * openDriver with the driver the adapter's connection got, so it passes
 * the same checks before any native code loads (#720), and it copies the
 * write-ahead log into the file so the adapter's commits never do.
 *
 * intervalMs after the last one ended, it runs a PASSIVE checkpoint, which
 * copies what it can and never waits on a writer. It does not keep the log
 * short by itself:
 * SQLite starts the log over only at a write that finds every frame
 * already copied, and a copy made on another connection always trails the
 * writes made while it ran. checkpointer.ts says how the adapter's
 * connection does that part.
 *
 * Messages in:  { id, type: 'checkpoint', mode: 'TRUNCATE' } to empty the
 *               log without waiting for a reader; { id, type: 'exec', sql }
 *               to run one statement; { id, type: 'migrate' } to apply the
 *               pending migrations (runMigrations, the same code the
 *               adapter runs); { type: 'close' } to close the connection
 *               and let the thread end.
 * Messages out: { ready: true } once the connection is open;
 *               { id, busy?, error? } per request.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { openDriver } from './driver.js';

export interface CheckpointWorkerData {
  path: string;
  driver: 'native' | 'node';
  busyMs: number;
  intervalMs: number;
}

const port = parentPort;
if (!port) throw new Error('checkpoint-worker.ts runs as a worker thread');
const data = workerData as CheckpointWorkerData;

const db = openDriver(data.path, { driver: data.driver, fileMustExist: true, timeout: data.busyMs, allowFallback: false });

/** A checkpoint in `mode`, waiting at most `waitMs` for the lock it needs: whether a reader or writer held it off, and the log's length in frames. */
function checkpoint(mode: 'PASSIVE' | 'TRUNCATE', waitMs: number): { busy: number; log: number } {
  if (waitMs !== data.busyMs) db.pragma(`busy_timeout = ${waitMs}`);
  try {
    const out = db.pragma(`wal_checkpoint(${mode})`) as { busy?: number; log?: number } | Array<{ busy?: number; log?: number }> | undefined;
    const row = Array.isArray(out) ? out[0] : out;
    return { busy: Number(row?.busy ?? 0), log: Number(row?.log ?? 0) };
  } finally {
    if (waitMs !== data.busyMs) db.pragma(`busy_timeout = ${data.busyMs}`);
  }
}

/*
 * The next copy is scheduled intervalMs after this one ends, not on a fixed
 * beat: a copy that takes longer than the interval (a large backlog on a
 * slow disk) would otherwise start the next one at once and hold SQLite's
 * checkpoint lock nearly all the time, and the adapter's own tail
 * checkpoint, which is what lets the log start over, would find it taken
 * at every commit.
 */
let timer: NodeJS.Timeout | undefined;
const tick = () => {
  try {
    checkpoint('PASSIVE', data.busyMs);
  } catch {
    // A checkpoint that failed is tried again at the next tick.
  }
  timer = setTimeout(tick, data.intervalMs);
};
timer = setTimeout(tick, data.intervalMs);

let open = true;
type Request = { id: number; type: 'checkpoint'; mode: 'TRUNCATE' } | { id: number; type: 'exec'; sql: string } | { id: number; type: 'migrate' } | { type: 'close' };

port.on('message', (m: Request) => {
  if (m.type === 'close') {
    // Close the connection here, on its own thread, then let the thread end with nothing left to run.
    clearTimeout(timer);
    if (open) {
      open = false;
      db.close();
    }
    port.close();
    return;
  }
  if (m.type === 'migrate') {
    // Loaded here, not at the top: a thread that only checkpoints never needs the migrations.
    import('./migrations/index.js')
      .then(({ runMigrations }) => {
        runMigrations(db);
        port.postMessage({ id: m.id });
      })
      .catch((err: unknown) => port.postMessage({ id: m.id, error: err instanceof Error ? err.message : String(err) }));
    return;
  }
  try {
    if (m.type === 'checkpoint') {
      // A TRUNCATE never waits for a reader: it answers busy, and the adapter tries again while the reader reads.
      port.postMessage({ id: m.id, busy: checkpoint(m.mode, 0).busy });
    } else {
      db.exec(m.sql);
      port.postMessage({ id: m.id });
    }
  } catch (err) {
    port.postMessage({ id: m.id, error: err instanceof Error ? err.message : String(err) });
  }
});
port.postMessage({ ready: true });
