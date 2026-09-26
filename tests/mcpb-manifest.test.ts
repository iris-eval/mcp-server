/*
 * The MCPB manifest (mcpb/manifest.json) and the server.json entry that
 * points at the bundle.
 *
 * The manifest is what Claude Desktop reads to install and start Iris from
 * iris-eval.mcpb: the name and icon it shows, the settings it asks for, and
 * the command line and environment it starts the server with. It restates
 * facts that live elsewhere — the version, the tools, the environment
 * variables, the Node range — so each one is pinned here to its source,
 * on every PR, without building a bundle. The built bundle itself is
 * started and checked end to end by the CI mcpb job (tests/mcpb/).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv from 'ajv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createIrisServer } from '../src/server.js';
import { createCustomRuleStore } from '../src/custom-rule-store.js';
import { SqliteAdapter } from '../src/storage/sqlite-adapter.js';
import { defaultConfig } from '../src/config/defaults.js';
import { COMMAND, PRODUCT_NAME } from '../src/identity.js';
import { NODE_SQLITE_MIN } from '../src/storage/driver.js';
// @ts-ignore — plain .mjs module
import { BUNDLE_NAME } from '../scripts/mcpb/pack.mjs';

const root = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

type UserConfigOption = { type: string; title: string; description: string; required?: boolean; default?: unknown; sensitive?: boolean };
const manifest = JSON.parse(read('mcpb/manifest.json')) as {
  manifest_version: string;
  name: string;
  display_name: string;
  version: string;
  description: string;
  author: unknown;
  repository: { type: string; url: string };
  homepage: string;
  license: string;
  icon: string;
  privacy_policies: string[];
  server: { type: string; entry_point: string; mcp_config: { command: string; args: string[]; env: Record<string, string> } };
  tools: { name: string; description: string }[];
  compatibility: { platforms: string[]; runtimes: { node: string } };
  user_config: Record<string, UserConfigOption>;
};
const pkg = JSON.parse(read('package.json')) as {
  name: string;
  version: string;
  description: string;
  author: unknown;
  license: string;
  homepage: string;
  repository: { url: string };
  engines: { node: string };
  files: string[];
  bin: Record<string, string>;
};
type RegistryPackage = { registryType: string; identifier: string; version?: string; transport: { type: string }; fileSha256?: string; registryBaseUrl?: string; environmentVariables?: { name: string }[] };
const serverJson = JSON.parse(read('server.json')) as { repository: { url: string }; packages: RegistryPackage[] };

describe('mcpb/manifest.json', () => {
  it('validates against the MCPB manifest schema for its version (v0.3, vendored from @anthropic-ai/mcpb 2.1.2)', () => {
    expect(manifest.manifest_version).toBe('0.3');
    const schema = JSON.parse(read('schemas/mcpb-manifest-v0.3.schema.json')) as Record<string, unknown>;
    const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
    const validate = ajv.compile(schema);
    expect(validate(manifest), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it('names the product as the package does: identifier, version, tagline, author, licence, homepage and repository', () => {
    expect(manifest.name).toBe(COMMAND);
    expect(manifest.display_name).toBe(PRODUCT_NAME);
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.description).toBe(pkg.description);
    expect(manifest.author).toEqual(pkg.author);
    expect(manifest.license).toBe(pkg.license);
    expect(manifest.homepage).toBe(pkg.homepage);
    expect(manifest.repository).toEqual({ type: 'git', url: serverJson.repository.url });
  });

  it('carries a 512x512 PNG icon, the size Claude Desktop asks for, rendered from the site logo', () => {
    const png = readFileSync(join(root, 'mcpb', manifest.icon));
    expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe('512x512');
  });

  it('starts the published entry point with the node command, which the host resolves to its own or the system Node', () => {
    expect(manifest.server.type).toBe('node');
    // The same file `npx @iris-eval/mcp-server` runs: the package's bin.
    expect(manifest.server.entry_point).toBe(pkg.bin[COMMAND]);
    expect(pkg.files).toContain(manifest.server.entry_point.split('/')[0]);
    expect(manifest.server.mcp_config.command).toBe('node');
    expect(manifest.server.mcp_config.args).toEqual([`\${__dirname}/${manifest.server.entry_point}`]);
  });

  it('runs over stdio on Node\'s built-in SQLite, and declares exactly the Node range where that driver exists', () => {
    const env = manifest.server.mcp_config.env;
    expect(env.IRIS_TRANSPORT).toBe('stdio');
    // No native addon in the bundle (scripts/mcpb/pack.mjs): the driver is chosen, never fallen back to.
    expect(env.IRIS_SQLITE_DRIVER).toBe('node');
    expect(manifest.compatibility.runtimes.node).toBe(pkg.engines.node);
    expect(pkg.engines.node).toBe(`>=${NODE_SQLITE_MIN}`);
    expect(manifest.compatibility.platforms.sort()).toEqual(['darwin', 'linux', 'win32']);
  });

  it('every setting is optional, has a default, and reaches the server through exactly one documented variable', () => {
    const env = manifest.server.mcp_config.env;
    const documented = new Set(serverJson.packages.flatMap((p) => (p.environmentVariables ?? []).map((e) => e.name)));
    for (const name of Object.keys(env)) expect(documented.has(name), `${name} is in server.json`).toBe(true);
    for (const [key, option] of Object.entries(manifest.user_config)) {
      // A setting with no default reaches the server as the literal text "${user_config.<key>}" when left empty.
      expect(option.required, key).toBe(false);
      expect(option.default, key).toBeDefined();
      const uses = Object.entries(env).filter(([, value]) => value.includes(`\${user_config.${key}}`));
      expect(uses.map(([name]) => name), key).toHaveLength(1);
    }
    const referenced = [...JSON.stringify(manifest.server.mcp_config).matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]);
    for (const name of referenced) {
      expect(name === '__dirname' || Object.keys(manifest.user_config).includes(name.replace(/^user_config\./, '')), name).toBe(true);
    }
  });

  it('asks for the judge keys as optional, masked settings that start empty, and leaves the dashboard off', () => {
    for (const [key, variable] of [['anthropic_api_key', 'IRIS_ANTHROPIC_API_KEY'], ['openai_api_key', 'IRIS_OPENAI_API_KEY']]) {
      expect(manifest.user_config[key], key).toMatchObject({ type: 'string', sensitive: true, required: false, default: '' });
      expect(manifest.server.mcp_config.env[variable]).toBe(`\${user_config.${key}}`);
    }
    expect(manifest.user_config.dashboard).toMatchObject({ type: 'boolean', required: false, default: false });
    expect(manifest.server.mcp_config.env.IRIS_DASHBOARD).toBe('${user_config.dashboard}');
    for (const url of manifest.privacy_policies) expect(url.startsWith('https://'), url).toBe(true);
  });
});

describe('mcpb/manifest.json — the tools', () => {
  let storage: SqliteAdapter;
  let client: Client;
  let ruleDir: string;

  beforeAll(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    ruleDir = mkdtempSync(join(tmpdir(), 'iris-mcpb-manifest-'));
    const ruleStore = createCustomRuleStore({ pathFor: () => join(ruleDir, 'custom-rules.json'), auditPath: join(ruleDir, 'audit.log') });
    const server = createIrisServer(defaultConfig, storage, ruleStore);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.mcpServer.connect(serverTransport);
    client = new Client({ name: 'mcpb-manifest', version: '0.0.0' });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await storage.close();
    rmSync(ruleDir, { recursive: true, force: true });
  });

  it('lists every tool the server registers, in registration order, with the opening of its own description', async () => {
    const { tools } = await client.listTools();
    expect(manifest.tools.map((t) => t.name)).toEqual(tools.map((t) => t.name));
    for (const [i, tool] of tools.entries()) {
      // Everything up to the first full stop, so a question that opens a description stays with its answer.
      expect(manifest.tools[i].description, tool.name).toBe((tool.description ?? '').split(/(?<=\.)\s/)[0]);
    }
  });
});

describe('server.json — the MCPB package', () => {
  const mcpb = serverJson.packages.filter((p) => p.registryType === 'mcpb');

  it('names exactly one bundle: this release\'s asset on GitHub, over stdio', () => {
    expect(mcpb).toHaveLength(1);
    expect(mcpb[0].identifier).toBe(`${serverJson.repository.url}/releases/download/v${pkg.version}/${BUNDLE_NAME}`);
    expect(mcpb[0].version).toBe(pkg.version);
    expect(mcpb[0].transport).toEqual({ type: 'stdio' });
  });

  it('passes the checks the MCP Registry runs on an MCPB package (internal/validators/registries/mcpb.go, registry v1.8.1)', () => {
    const url = new URL(mcpb[0].identifier);
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('github.com');
    expect(url.pathname).toMatch(/^\/([a-zA-Z0-9]([a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?)\/([a-zA-Z0-9._-]+)\/releases\/download\/([^/]+)\/([^/]+)$/);
    expect(mcpb[0].identifier.toLowerCase()).toContain('mcp');
    expect(mcpb[0].registryBaseUrl).toBeUndefined();
  });

  it('carries no fileSha256 in the repository: the release stamps the hash of the bundle it attached, then publishes', () => {
    // The registry requires the hash. It is a fact about the file the release
    // builds and attaches, so release.yml computes it from that file and writes
    // it into server.json in the publishing job; a value typed here would be a
    // hash of nothing yet built.
    expect(mcpb[0].fileSha256).toBeUndefined();
    const release = read('.github/workflows/release.yml');
    expect(release).toContain('fileSha256');
  });
});
