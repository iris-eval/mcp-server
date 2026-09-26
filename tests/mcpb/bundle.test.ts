/*
 * The MCPB bundle, started the way a host starts it.
 *
 * The CI job (`mcpb` in .github/workflows/ci.yml) builds this commit, packs
 * it with `npm pack`, builds iris-eval.mcpb from that tarball
 * (scripts/mcpb/pack.mjs), and runs this file on Linux, macOS and Windows,
 * at the lowest Node the manifest admits and at the current one. It points
 * two variables at its work:
 *
 *   IRIS_MCPB_BUNDLE   the .mcpb file under test
 *   IRIS_MCPB_LIB      a directory where @anthropic-ai/mcpb is installed —
 *                      the reference implementation of the format, whose
 *                      unpacker and launch-config builder Claude Desktop
 *                      uses (its README says so). The tests call those, not
 *                      a copy of them.
 *
 * The bundle is unpacked by that unpacker, its manifest parsed by that
 * package's schema, and the command line and environment built by its
 * getMcpConfigForManifest from the manifest and a user's settings. The
 * server is then started from exactly that and must answer tools/list
 * with every tool the manifest declares, store and read back a trace on
 * Node's built-in SQLite, and carry each setting to the place it acts.
 *
 * The root vitest config excludes this folder; the job runs it through
 * tests/mcpb/vitest.config.ts, and outside that job it fails on purpose.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
// @ts-ignore — plain .mjs module
import { readZip } from '../../scripts/mcpb/archive.mjs';

const bundlePath = process.env.IRIS_MCPB_BUNDLE ? resolve(process.env.IRIS_MCPB_BUNDLE) : '';
const libDir = process.env.IRIS_MCPB_LIB ? resolve(process.env.IRIS_MCPB_LIB) : '';

type UserConfigOption = { type: string; required?: boolean; default?: unknown; sensitive?: boolean };
type Manifest = {
  version: string;
  server: { entry_point: string; mcp_config: { command: string; args: string[]; env: Record<string, string> } };
  tools: { name: string; description: string }[];
  user_config: Record<string, UserConfigOption>;
  compatibility: { runtimes: { node: string } };
};
type McpConfig = { command: string; args: string[]; env: Record<string, string> };
type McpbLib = {
  unpackExtension(options: { mcpbPath: string; outputDir: string; silent?: boolean }): Promise<boolean>;
  getMcpConfigForManifest(options: {
    manifest: unknown;
    extensionPath: string;
    systemDirs: Record<string, string>;
    userConfig: Record<string, unknown>;
    pathSeparator: string;
  }): Promise<McpConfig | undefined>;
  MANIFEST_SCHEMAS: Record<string, { safeParse(v: unknown): { success: boolean; error?: unknown } }>;
};

let lib: McpbLib;
let dir: string;
let manifest: Manifest;
const homes: string[] = [];

beforeAll(async () => {
  if (!bundlePath || !libDir) return;
  lib = (await import(pathToFileURL(join(libDir, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'index.js')).href)) as McpbLib;
  dir = mkdtempSync(join(tmpdir(), 'iris-mcpb-'));
  expect(await lib.unpackExtension({ mcpbPath: bundlePath, outputDir: dir, silent: true })).toBe(true);
  manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
});

afterAll(() => {
  for (const d of [dir, ...homes]) {
    if (!d) continue;
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // A server that has just exited can still hold a file on Windows; a leftover temp dir is harmless.
    }
  }
});

function walk(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** The launch config the host builds for these settings, from the reference implementation. */
async function launchConfig(userConfig: Record<string, unknown>): Promise<McpConfig> {
  const home = mkdtempSync(join(tmpdir(), 'iris-mcpb-home-'));
  homes.push(home);
  const config = await lib.getMcpConfigForManifest({
    manifest,
    extensionPath: dir,
    systemDirs: { HOME: home, DESKTOP: join(home, 'Desktop'), DOCUMENTS: join(home, 'Documents'), DOWNLOADS: join(home, 'Downloads') },
    userConfig,
    pathSeparator: sep,
  });
  expect(config, 'the host refuses a config only when a required setting is missing, and none is').toBeDefined();
  return config!;
}

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => ok(port));
    });
  });
}

/** Starts the server from a launch config, the way the host's system-Node path does, with a scratch IRIS_HOME. */
async function start(config: McpConfig, extraEnv: Record<string, string> = {}): Promise<{ client: Client; stderr: () => string }> {
  expect(config.command).toBe('node');
  const home = mkdtempSync(join(tmpdir(), 'iris-mcpb-data-'));
  homes.push(home);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: config.args,
    env: { ...config.env, IRIS_HOME: home, IRIS_NO_AUTO_LAUNCH: '1', ...extraEnv },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: 'mcpb-bundle-test', version: '0.0.0' });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

const text = (result: unknown): string => ((result as { content: Array<{ text: string }> }).content[0]).text;
/** Everything up to the first full stop: a question that opens a description stays with its answer. */
const firstSentence = (s: string): string => s.split(/(?<=\.)\s/)[0];

describe('the MCPB bundle', () => {
  it('runs only in the CI mcpb job, with the bundle and the reference implementation', () => {
    expect(bundlePath, 'IRIS_MCPB_BUNDLE (see the header of this file)').not.toBe('');
    expect(libDir, 'IRIS_MCPB_LIB (see the header of this file)').not.toBe('');
    expect(existsSync(bundlePath), bundlePath).toBe(true);
  });

  it('unpacks with the reference unpacker to exactly the files this repository reads out of it', () => {
    const ours = readZip(readFileSync(bundlePath)) as Map<string, Buffer>;
    const theirs = walk(dir).map((f) => f.slice(dir.length + 1).split(sep).join('/'));
    expect(theirs.sort()).toEqual([...ours.keys()].sort());
    for (const [path, data] of ours) expect(readFileSync(join(dir, ...path.split('/'))).equals(data), path).toBe(true);
  });

  it("parses under the reference implementation's schema for its manifest version", () => {
    const raw = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { manifest_version: string };
    const parsed = lib.MANIFEST_SCHEMAS[raw.manifest_version].safeParse(raw);
    expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
  });

  it('carries the published package and no native binary: better-sqlite3 is not inside', () => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string };
    expect(pkg.version).toBe(manifest.version);
    expect(existsSync(join(dir, manifest.server.entry_point))).toBe(true);
    expect(existsSync(join(dir, 'node_modules', 'better-sqlite3'))).toBe(false);
    expect(walk(dir).filter((f) => f.endsWith('.node'))).toEqual([]);
  });

  it('with no settings, the host resolves every variable: nothing reaches the server as a literal ${...}', async () => {
    const config = await launchConfig({});
    expect(JSON.stringify(config)).not.toContain('${');
    expect(config.args).toEqual([`${dir}/${manifest.server.entry_point}`]);
    expect(config.env).toMatchObject({ IRIS_TRANSPORT: 'stdio', IRIS_SQLITE_DRIVER: 'node', IRIS_DASHBOARD: 'false', IRIS_ANTHROPIC_API_KEY: '', IRIS_OPENAI_API_KEY: '' });
  });

  it('starts over stdio, answers tools/list with every tool the manifest declares, and stores a trace on node:sqlite', async () => {
    const { client, stderr } = await start(await launchConfig({}));
    try {
      expect(client.getServerVersion()?.version).toBe(manifest.version);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(manifest.tools.map((t) => t.name).sort());
      // The manifest's description is the first sentence of the one the server registers, so the two cannot drift.
      const live = new Map(tools.map((t) => [t.name, t.description ?? '']));
      for (const tool of manifest.tools) expect(tool.description, tool.name).toBe(firstSentence(live.get(tool.name)!));

      const logged = JSON.parse(text(await client.callTool({ name: 'log_trace', arguments: { agent_name: 'mcpb-bundle', input: 'What is 2+2?', output: 'The answer is 4.' } }))) as { trace_id: string };
      expect(logged.trace_id).toBeTruthy();
      const evaluated = await client.callTool({ name: 'evaluate_output', arguments: { output: 'The answer is 4.', input: 'What is 2+2?', trace_id: logged.trace_id } });
      expect(evaluated.isError).toBeFalsy();
      const traces = JSON.parse(text(await client.callTool({ name: 'get_traces', arguments: { limit: 10 } }))) as { traces: { trace_id: string }[] };
      expect(traces.traces.map((t) => t.trace_id)).toContain(logged.trace_id);

      const capabilities = JSON.parse(((await client.readResource({ uri: 'iris://capabilities' })).contents[0] as { text: string }).text) as { judge: { enabled: boolean } };
      expect(capabilities.judge.enabled, 'no key set: the judge is off').toBe(false);
    } finally {
      await client.close();
    }
    // Chosen, not fallen back to: the native module is absent and nothing tried to load it.
    expect(stderr()).not.toMatch(/better-sqlite3|falling back/i);
  });

  it('carries a judge key and the dashboard setting to the server: the judge turns on, the dashboard serves on node:sqlite', async () => {
    const config = await launchConfig({ anthropic_api_key: 'sk-ant-bundle-test', dashboard: true });
    expect(config.env).toMatchObject({ IRIS_ANTHROPIC_API_KEY: 'sk-ant-bundle-test', IRIS_DASHBOARD: 'true' });
    // The port is the test's choice so parallel runners never collide; the manifest leaves the default.
    const port = await freePort();
    const { client } = await start(config, { IRIS_DASHBOARD_PORT: String(port) });
    try {
      const capabilities = JSON.parse(((await client.readResource({ uri: 'iris://capabilities' })).contents[0] as { text: string }).text) as { judge: { enabled: boolean; provider: string | null } };
      expect(capabilities.judge).toMatchObject({ enabled: true, provider: 'anthropic' });
      let health: { status: string; driver: string } | undefined;
      for (let i = 0; i < 50 && !health; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
          if (res.ok) health = (await res.json()) as { status: string; driver: string };
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      expect(health, 'the dashboard answered /api/v1/health').toBeDefined();
      expect(health).toMatchObject({ status: 'ok', driver: 'node' });
    } finally {
      await client.close();
    }
  });

  it('declares the Node range the package declares, and this runner is inside it', () => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { engines: { node: string } };
    expect(manifest.compatibility.runtimes.node).toBe(pkg.engines.node);
    const [major, minor] = process.versions.node.split('.').map(Number);
    const [wantMajor, wantMinor] = pkg.engines.node.replace('>=', '').split('.').map(Number);
    expect(major > wantMajor || (major === wantMajor && minor >= wantMinor), `Node ${process.versions.node} against ${pkg.engines.node}`).toBe(true);
  });
});
