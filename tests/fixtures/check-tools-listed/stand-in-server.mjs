// A stand-in for dist/index.js, for tests/unit/scripts/check-tools-listed.test.ts.
// It records the data locations it was started with (to STAND_IN_ENV_OUT) and
// answers the MCP handshake over stdio only when both IRIS_HOME and
// IRIS_DB_PATH are set, the way check-tools-listed.mjs must start the server.
// STAND_IN_MODE: "ok" (every tool .claims.json names), "short" (one fewer),
// "exit" (exits before answering).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { IRIS_HOME, IRIS_DB_PATH, STAND_IN_ENV_OUT, STAND_IN_MODE = 'ok' } = process.env;
if (STAND_IN_ENV_OUT) writeFileSync(STAND_IN_ENV_OUT, JSON.stringify({ IRIS_HOME: IRIS_HOME ?? null, IRIS_DB_PATH: IRIS_DB_PATH ?? null }));
if (!IRIS_HOME || !IRIS_DB_PATH) {
  process.stderr.write('stand-in: started without IRIS_HOME and IRIS_DB_PATH both set\n');
  process.exit(3);
}
if (STAND_IN_MODE === 'exit') process.exit(5);

const names = JSON.parse(readFileSync(join(process.cwd(), '.claims.json'), 'utf8')).mcpTools.names;
const listed = STAND_IN_MODE === 'short' ? names.slice(1) : names;

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      reply(msg.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stand-in', version: '0' } });
    } else if (msg.method === 'tools/list') {
      reply(msg.id, { tools: listed.map((name) => ({ name, inputSchema: { type: 'object' } })) });
    }
  }
});

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
