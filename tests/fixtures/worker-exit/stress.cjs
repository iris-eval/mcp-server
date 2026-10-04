/*
 * A worker thread with its own SQLite connection, started and ended again
 * and again, every way a worker in Iris can end. Each (driver, ending) pair
 * runs in child processes of its own, so a process that dies of a signal is
 * counted, not fatal to the count.
 *
 *   node stress.cjs                      every driver and ending, the summary as JSON on the last line;
 *                                        exit 1 when any process died
 *   node stress.cjs <driver> <ending> <n>  one child: n workers, "done" when none took the process down
 *
 * With WORKER_EXIT_SEARCH=1 it also runs Iris's own workers, the search
 * worker and the checkpoint worker (iris-workers.ts), the same way: from
 * the sources and from the build, on both drivers, every way each ends.
 *
 * Drivers:  native (better-sqlite3), node (node:sqlite).
 * Endings:
 *   close        the worker closes its own connection and its port, and ends by itself (Iris's close path)
 *   open         the worker closes its port with the connection still open (a worker that never closed)
 *   throw        the worker throws, uncaught, with the connection open (a worker that crashed)
 *   idle         terminate() a worker waiting for work, its connection open
 *   js-call      terminate() while a statement is calling a JS function registered on the connection
 *                (the search worker's index path calls one per match)
 *   native-call  terminate() while one statement runs in SQLite alone
 *   js-loop      terminate() in a JS loop of short statements
 */
'use strict';
const { spawnSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const DRIVERS = ['native', 'node'];
const ENDINGS = ['close', 'open', 'throw', 'idle', 'js-call', 'native-call', 'js-loop'];

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { driver, path } = workerData;
let db;
if (driver === 'node') {
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(path, { readOnly: true });
} else {
  const Database = require('better-sqlite3');
  db = new Database(path, { readonly: true });
}
db.function('hit', (x) => x + 1);
parentPort.on('message', (m) => {
  if (m === 'close') { db.close(); parentPort.close(); return; }
  if (m === 'open') { parentPort.close(); return; }
  if (m === 'throw') throw new Error('the worker crashed');
  parentPort.postMessage('started');
  if (m === 'js-call') db.prepare('SELECT count(*) AS n FROM t AS a, t AS b WHERE hit(a.a) > b.a').get();
  if (m === 'native-call') db.prepare('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000000) SELECT count(*) FROM c').get();
  if (m === 'js-loop') for (;;) db.prepare('SELECT count(*) AS n FROM t WHERE a > ?').get(1);
});
parentPort.postMessage('ready');
`;

function seed(driver) {
  const dir = mkdtempSync(join(tmpdir(), 'iris-worker-exit-'));
  const path = join(dir, 'w.db');
  if (driver === 'node') {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (a INTEGER)');
    db.exec(`INSERT INTO t SELECT value FROM (WITH RECURSIVE c(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM c WHERE value < 20000) SELECT value FROM c)`);
    db.close();
  } else {
    const Database = require('better-sqlite3');
    const db = new Database(path);
    db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (a INTEGER)');
    db.exec(`INSERT INTO t SELECT value FROM (WITH RECURSIVE c(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM c WHERE value < 20000) SELECT value FROM c)`);
    db.close();
  }
  return { dir, path };
}

async function child(driver, ending, n) {
  const { dir, path } = seed(driver);
  for (let i = 0; i < n; i++) {
    const w = new Worker(WORKER, { eval: true, workerData: { driver, path } });
    // A worker that throws reports it here; what is under test is whether the process survives it.
    w.on('error', () => undefined);
    const exited = new Promise((r) => w.once('exit', r));
    await once(w, 'message');
    if (ending === 'close' || ending === 'open' || ending === 'throw') {
      w.postMessage(ending);
    } else if (ending === 'idle') {
      await w.terminate();
    } else {
      const started = once(w, 'message');
      w.postMessage(ending);
      await started;
      // Let the statement get going, and the runtime be inside it, before the terminate.
      await new Promise((r) => setTimeout(r, 2 + (i % 5)));
      await w.terminate();
    }
    await exited;
  }
  rmSync(dir, { recursive: true, force: true });
  process.stdout.write('done\n');
}

function tally(label, processes, perProcess, args, env) {
  const row = { run: label, workers: 0, clean: 0, died: [] };
  for (let p = 0; p < processes; p++) {
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 600_000, env: { ...process.env, ...env } });
    row.workers += perProcess;
    if (r.status === 0 && r.stdout.includes('done')) row.clean += 1;
    else {
      const lines = (r.stderr || '').split('\n').filter((l) => l && !/ExperimentalWarning|trace-warnings/.test(l));
      row.died.push({ status: r.status, signal: r.signal, stderr: lines.slice(0, 8).join(' | ').slice(0, 800) });
    }
  }
  const deaths = row.died.map((d) => d.signal || `exit ${d.status}`).join(', ');
  process.stderr.write(`${label}: ${row.clean}/${processes} processes clean (${row.workers} workers)${deaths ? ` — died: ${deaths}` : ''}\n`);
  for (const d of row.died) process.stderr.write(`    ${d.signal || `exit ${d.status}`}: ${d.stderr}\n`);
  return row;
}

function parent() {
  const processes = Number(process.env.WORKER_EXIT_PROCESSES || 10);
  const perProcess = Number(process.env.WORKER_EXIT_WORKERS || 30);
  const drivers = (process.env.WORKER_EXIT_DRIVERS || DRIVERS.join(',')).split(',');
  const summary = { node: process.versions.node, platform: `${process.platform}-${process.arch}`, processes, perProcess, results: [] };
  for (const driver of drivers) {
    for (const ending of ENDINGS) summary.results.push(tally(`raw ${driver} ${ending}`, processes, perProcess, [__filename, driver, ending, String(perProcess)]));
  }
  if (process.env.WORKER_EXIT_SEARCH === '1') {
    const cycles = join(__dirname, 'iris-workers.ts');
    // No --import: every thread would inherit it, and an installed server's threads have no loader (iris-workers.ts
    // says why). Node strips the file's types itself; a Node that does not by default is given the flag.
    const strip = process.features.typescript ? [] : ['--experimental-strip-types'];
    for (const from of ['src', 'dist']) {
      for (const driver of drivers) {
        for (const ending of ['store', 'search-stuck', 'checkpoint-crash', 'checkpoint-kill']) {
          const label = `iris ${from} ${driver} ${ending}`;
          summary.results.push(tally(label, processes, perProcess, [...strip, cycles, driver, ending, String(perProcess)], { WORKER_EXIT_FROM: from }));
        }
      }
    }
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.results.some((r) => r.died.length > 0)) process.exitCode = 1;
}

if (process.argv.length > 2) {
  child(process.argv[2], process.argv[3], Number(process.argv[4])).catch((err) => {
    process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
} else {
  parent();
}
