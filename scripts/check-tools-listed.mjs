#!/usr/bin/env node
// Start the built server over stdio, as an MCP client or a directory's
// inspector does, and require `tools/list` to return every tool the
// truthbase names. Used by CI's fresh-clone job, which builds the way
// directories that build from a clone do.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expected = JSON.parse(readFileSync(join(root, '.claims.json'), 'utf8')).mcpTools.names;

const child = spawn(process.execPath, [join(root, 'dist', 'index.js')], {
  cwd: root,
  env: { ...process.env, IRIS_TRANSPORT: 'stdio', IRIS_DASHBOARD: 'false', IRIS_NO_AUTO_LAUNCH: '1' },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buffer = '';
const timer = setTimeout(() => fail('no tools/list answer within 30 s'), 30_000);

function fail(message) {
  console.error(`[check-tools-listed] ${message}`);
  child.kill();
  process.exit(1);
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
      clearTimeout(timer);
      const names = (msg.result?.tools ?? []).map((t) => t.name).sort();
      const missing = expected.filter((n) => !names.includes(n));
      if (names.length !== expected.length || missing.length > 0) {
        fail(`tools/list returned ${names.length} tools (${names.join(', ')}); expected ${expected.length}, missing ${missing.join(', ') || 'none'}`);
      }
      console.log(`[check-tools-listed] ${names.length} tools listed: ${names.join(', ')}`);
      child.kill();
      process.exit(0);
    }
  }
});

child.on('exit', (code) => {
  if (code !== null && code !== 0) fail(`server exited with ${code} before answering`);
});

child.stdin.write(
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fresh-clone-check', version: '1' } },
  }) + '\n',
);
