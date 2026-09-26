/*
 * Starts the bundle inside Electron's own Node, the way Claude Desktop runs
 * a Node bundle when its built-in runtime satisfies the manifest.
 *
 * Claude Desktop is an Electron app. For a `node` server it forks an
 * Electron utility process (utilityProcess.fork) — not a system `node` —
 * when "use built-in Node.js for MCP" is on (the default) and Electron's
 * Node version satisfies `compatibility.runtimes.node`; the server's stdio
 * is carried over a MessagePort. That runtime is not any Node release: it
 * has its own ABI, which is why the bundle holds no native addon and runs
 * on node:sqlite. The system-Node path is tests/mcpb/bundle.test.ts.
 *
 * This harness does the same with an Electron the CI job pins: builds the
 * launch config with the reference implementation, forks host.mjs in a
 * utility process with the entry point and the manifest's environment,
 * and speaks JSON-RPC through the port: initialize, tools/list, log_trace,
 * get_traces. It prints one JSON line with what it saw and exits 0 only
 * when every tool the manifest declares was listed and the trace written
 * came back.
 *
 *   electron tests/mcpb/electron-host/main.mjs <unpacked bundle dir> <dir with @anthropic-ai/mcpb installed>
 */
import { app, MessageChannelMain, utilityProcess } from 'electron';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [bundleDir, libDir] = process.argv.slice(-2);
const here = dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = 60_000;

function satisfiesMin(version, range) {
  const m = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!m) throw new Error(`unsupported range ${range}`);
  const [a, b, c] = version.split('.').map(Number);
  const [x, y, z] = m.slice(1).map(Number);
  return a !== x ? a > x : b !== y ? b > y : c >= z;
}

async function run() {
  const lib = await import(pathToFileURL(join(libDir, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'index.js')).href);
  const manifest = JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf8'));
  const range = manifest.compatibility.runtimes.node;
  // The host's rule: the built-in runtime is used only when it satisfies the manifest.
  if (!satisfiesMin(process.versions.node, range)) {
    throw new Error(`Electron ${process.versions.electron} carries Node ${process.versions.node}, outside ${range}: a host would not use it`);
  }
  const home = mkdtempSync(join(tmpdir(), 'iris-mcpb-electron-'));
  const config = await lib.getMcpConfigForManifest({
    manifest,
    extensionPath: bundleDir,
    systemDirs: { HOME: home },
    userConfig: {},
    pathSeparator: sep,
  });
  const [entry, ...args] = config.args;
  const child = utilityProcess.fork(join(here, 'host.mjs'), [entry, ...args], {
    env: { ...process.env, ...config.env, IRIS_HOME: home, IRIS_NO_AUTO_LAUNCH: '1' },
    stdio: 'pipe',
    serviceName: 'iris-mcpb-host',
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const { port1, port2 } = new MessageChannelMain();

  const pending = new Map();
  let buffered = '';
  port1.on('message', ({ data }) => {
    if (data.type !== 'stdout') return;
    buffered += data.content;
    let nl;
    while ((nl = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  port1.start();

  let nextId = 1;
  const send = (message) => port1.postMessage({ type: 'stdin', data: JSON.stringify(message) });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (message) => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)));
      send({ jsonrpc: '2.0', id, method, params });
    });

  await new Promise((resolve) => child.once('spawn', resolve));
  child.postMessage({ type: 'init' }, [port2]);

  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'iris-mcpb-electron-host', version: '0.0.0' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const { tools } = await request('tools/list', {});
  const logged = JSON.parse((await request('tools/call', { name: 'log_trace', arguments: { agent_name: 'mcpb-electron', input: 'What is 2+2?', output: 'The answer is 4.' } })).content[0].text);
  const traces = JSON.parse((await request('tools/call', { name: 'get_traces', arguments: { limit: 10 } })).content[0].text);
  child.kill();

  const listed = tools.map((t) => t.name).sort();
  const declared = manifest.tools.map((t) => t.name).sort();
  const report = {
    electron: process.versions.electron,
    node: process.versions.node,
    modules: process.versions.modules,
    server: init.serverInfo,
    tools: listed.length,
    everyDeclaredToolListed: JSON.stringify(listed) === JSON.stringify(declared),
    traceStoredAndRead: traces.traces.some((t) => t.trace_id === logged.trace_id),
    nativeFallback: /better-sqlite3|falling back/i.test(stderr),
  };
  console.log(JSON.stringify(report));
  return report.everyDeclaredToolListed && report.traceStoredAndRead && !report.nativeFallback && init.serverInfo.version === manifest.version;
}

app.whenReady().then(async () => {
  const timer = setTimeout(() => {
    console.error(`no answer within ${TIMEOUT_MS} ms`);
    app.exit(1);
  }, TIMEOUT_MS);
  try {
    const ok = await run();
    clearTimeout(timer);
    app.exit(ok ? 0 : 1);
  } catch (err) {
    console.error(err instanceof Error ? err.stack : String(err));
    app.exit(1);
  }
});
