#!/usr/bin/env node
// Start the built server over stdio, as an MCP client or a directory's
// inspector does, and require `tools/list` to return every tool the
// truthbase names. Used by CI's fresh-clone job, which builds the way
// directories that build from a clone do.
//
// The server runs on a throwaway IRIS_HOME and database, removed on exit:
// run on a developer's machine, it must not open, migrate or read the
// ~/.iris of the Iris they actually use.
//
// Usage: node scripts/check-tools-listed.mjs [server-entry]
// (default dist/index.js; tests pass a stand-in server).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expected = JSON.parse(readFileSync(join(root, '.claims.json'), 'utf8')).mcpTools.names;
const home = mkdtempSync(join(tmpdir(), 'iris-tools-listed-'));

const entry = resolve(process.argv[2] ?? join(root, 'dist', 'index.js'));

const child = spawn(process.execPath, [entry], {
  cwd: root,
  env: {
    ...process.env,
    IRIS_HOME: home,
    IRIS_DB_PATH: join(home, 'iris.db'),
    IRIS_TRANSPORT: 'stdio',
    IRIS_DASHBOARD: 'false',
    IRIS_NO_AUTO_LAUNCH: '1',
  },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buffer = '';
const timer = setTimeout(() => fail('no tools/list answer within 30 s'), 30_000);

let finished = false;

// The child may hold the database a moment longer on Windows; a leftover temp directory is harmless.
function removeHome() {
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
}

// Every way out removes the temp home, an uncaught error included.
process.on('exit', removeHome);

// A server that has already exited closes its end of the pipe, and the next
// write to it fails. That is not this script's failure to report: the 'exit'
// handler below says the server exited, and with which code. Without a
// listener the write error would end the script first, with a stack trace
// instead of that sentence.
child.stdin.on('error', () => {});

function done(code) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  const exit = () => {
    removeHome();
    process.exit(code);
  };
  if (child.exitCode !== null || child.signalCode !== null) return exit();
  child.once('exit', exit);
  child.kill();
  setTimeout(exit, 5_000);
}

function fail(message) {
  console.error(`[check-tools-listed] ${message}`);
  done(1);
}

child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === 1) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    } else if (msg.id === 2) {
      const names = (msg.result?.tools ?? []).map((t) => t.name).sort();
      const missing = expected.filter((n) => !names.includes(n));
      if (names.length !== expected.length || missing.length > 0) {
        return fail(`tools/list returned ${names.length} tools (${names.join(', ')}); expected ${expected.length}, missing ${missing.join(', ') || 'none'}`);
      }
      console.log(`[check-tools-listed] ${names.length} tools listed: ${names.join(', ')}`);
      return done(0);
    }
  }
});

child.on('exit', (code, signal) => {
  if (!finished) fail(`server exited (${code ?? signal}) before answering tools/list`);
});

child.stdin.write(
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fresh-clone-check', version: '1' } },
  }) + '\n',
);
