/*
 * The search worker's thread (#703). It holds its own read-only connection
 * to the store and answers one search at a time with matchSearch, so the
 * work a search does before its first result, which nothing can interrupt,
 * never runs on the server's event loop. search-worker-client.ts starts it
 * and talks to it.
 *
 * Messages in:  { id, request } to search; { type: 'close' } to close the
 *               connection and let the thread end.
 * Messages out: { type: 'ready' } once the connection is open;
 *               { id, result } or { id, error: { message } } per search.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { openDriver } from './driver.js';
import { installSearchFunctions, matchSearch, type MatchRequest } from './search-match.js';

export interface SearchWorkerData {
  path: string;
  driver: 'native' | 'node';
  busyTimeoutMs: number;
}

const port = parentPort;
if (!port) throw new Error('search-worker.ts runs as a worker thread');
const data = workerData as SearchWorkerData;

const db = openDriver(data.path, { driver: data.driver, readOnly: true, fileMustExist: true, timeout: data.busyTimeoutMs, allowFallback: false });
installSearchFunctions(db);
let open = true;

port.on('message', (msg: { id: number; request: MatchRequest } | { type: 'close' }) => {
  if ('type' in msg) {
    // Close the connection here, on its own thread, then let the thread end with nothing left to run.
    if (open) {
      open = false;
      db.close();
    }
    port.close();
    return;
  }
  try {
    port.postMessage({ id: msg.id, result: matchSearch(db, msg.request) });
  } catch (err) {
    port.postMessage({ id: msg.id, error: { message: err instanceof Error ? err.message : String(err) } });
  }
});
port.postMessage({ type: 'ready' });
