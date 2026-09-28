/*
 * Prepared statements that become garbage while V8 collects on its own,
 * with the database open and then after it is closed. On a better-sqlite3
 * binary compiled against Node 24.19+ headers, running on a Node without
 * the global cleanup-hook list, the first collection of a statement aborts
 * the process: "Assertion failed: (env) != nullptr" (nodejs/node#65446).
 * An explicit global.gc() does not reach that path; the allocation below does.
 *
 * Usage: node collect-statements.cjs [statements]   (exit 0 and "survived" when nothing aborted)
 */
'use strict';
const Database = require('better-sqlite3');

const N = Number(process.argv[2] || 100000);
const churn = (db, n) => {
  let junk = [];
  for (let i = 0; i < n; i++) {
    if (db) db.prepare('SELECT a FROM t WHERE a = ?').get(i);
    junk.push({ a: i, s: 'x'.repeat(16) });
    if (junk.length > 1000) junk = [];
  }
};

const db = new Database(':memory:');
db.exec('CREATE TABLE t (a INTEGER)');
churn(db, N);
// Closed: every statement is finalized by close(), and their objects are still freed later.
let kept = [];
for (let i = 0; i < 2000; i++) kept.push(db.prepare('SELECT a FROM t WHERE a = ?'));
db.close();
kept = [];
churn(null, N);
process.stdout.write('survived\n');
