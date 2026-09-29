/*
 * One WAL database file opened in one process by two copies of SQLite:
 * better-sqlite3's bundled SQLite on the main thread, Node's built-in
 * node:sqlite on a worker thread (and the reverse). POSIX advisory locks
 * belong to the process, so neither copy sees the other's locks: each can
 * take itself for the only user of the -shm file and reset it while the
 * other has it mapped (sqlite.org/howtocorrupt.html, section 2.2.1). The
 * same run with one copy on both threads is the control.
 *
 *   node two-sqlites.cjs <main: native|node> <worker: native|node> <rounds>
 *
 * Prints "done" when the process survived every round and the file passed
 * PRAGMA integrity_check.
 */
'use strict';
const { Worker } = require('node:worker_threads');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const [mainDriver, workerDriver, roundsArg] = process.argv.slice(2);
const rounds = Number(roundsArg || 200);

function open(driver, path) {
  if (driver === 'node') {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path);
    return { exec: (s) => db.exec(s), get: (s, ...p) => db.prepare(s).get(...p), run: (s, ...p) => db.prepare(s).run(...p), close: () => db.close() };
  }
  const Database = require('better-sqlite3');
  const db = new Database(path);
  return { exec: (s) => db.exec(s), get: (s, ...p) => db.prepare(s).get(...p), run: (s, ...p) => db.prepare(s).run(...p), close: () => db.close() };
}

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { driver, path } = workerData;
let db;
if (driver === 'node') { const { DatabaseSync } = require('node:sqlite'); db = new DatabaseSync(path, { readOnly: true }); }
else { const Database = require('better-sqlite3'); db = new Database(path, { readonly: true }); }
let n = 0;
for (let i = 0; i < 50; i++) n += db.prepare('SELECT count(*) AS n FROM t').get().n;
db.close();
parentPort.postMessage(n);
`;

(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iris-two-sqlites-'));
  const path = join(dir, 'x.db');
  const db = open(mainDriver, path);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (a INTEGER, b TEXT)');
  for (let r = 0; r < rounds; r++) {
    const w = new Worker(WORKER, { eval: true, workerData: { driver: workerDriver, path } });
    w.on('error', () => undefined);
    const done = new Promise((resolve) => w.once('exit', resolve));
    // The main thread writes while the worker reads, opens and closes.
    for (let i = 0; i < 20; i++) db.run('INSERT INTO t VALUES (?, ?)', r * 20 + i, 'x'.repeat(200));
    await done;
  }
  const check = db.get('PRAGMA integrity_check');
  db.close();
  rmSync(dir, { recursive: true, force: true });
  if (check.integrity_check !== 'ok') {
    process.stderr.write(`integrity_check: ${check.integrity_check}\n`);
    process.exit(2);
  }
  process.stdout.write('done\n');
})().catch((err) => {
  process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
