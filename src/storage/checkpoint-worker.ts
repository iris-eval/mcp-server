/*
 * The checkpoint worker's thread (checkpointer.ts starts it and talks to
 * it). It holds its own connection to the store, opened through
 * openDriver with the driver the adapter's connection got, so it passes
 * the same checks before any native code loads (#720), and it copies the
 * write-ahead log into the file so the adapter's commits never do.
 *
 * Every intervalMs it runs a PASSIVE checkpoint, which copies what it can
 * and never waits on a writer. It does not keep the log short by itself:
 * SQLite starts the log over only at a write that finds every frame
 * already copied, and a copy made on another connection always trails the
 * writes made while it ran. checkpointer.ts says how the adapter's
 * connection does that part.
 *
 * Messages in:  { id, type: 'checkpoint', mode: 'TRUNCATE' } to empty the
 *               log without waiting for a reader; { id, type: 'exec', sql }
 *               to run one statement; { type: 'close' } to close the
 *               connection and let the thread end.
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

const timer = setInterval(() => {
  try {
    checkpoint('PASSIVE', data.busyMs);
  } catch {
    // A checkpoint that failed is tried again at the next tick.
  }
}, data.intervalMs);

let open = true;
port.on('message', (m: { id: number; type: 'checkpoint'; mode: 'TRUNCATE' } | { id: number; type: 'exec'; sql: string } | { type: 'close' }) => {
  if (m.type === 'close') {
    // Close the connection here, on its own thread, then let the thread end with nothing left to run.
    clearInterval(timer);
    if (open) {
      open = false;
      db.close();
    }
    port.close();
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
