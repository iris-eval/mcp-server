/*
 * .well-known/mcp.json renderer — writes website/public/.well-known/mcp.json
 * from the BUILT server, so the discovery manifest cannot describe a server
 * that does not exist.
 *
 * Why this exists: the manifest was hand-maintained. On 2026-09-07 it
 * listed twelve tools with descriptions written years apart from the tool
 * descriptions the server actually sends, one resource of five, no prompt,
 * and one install block. The version was kept current by sync-versions.mjs
 * and the tool NAMES by a test; everything else drifted silently, because
 * nothing read it against the server.
 *
 * Now the server is booted in-process over an in-memory MCP transport and
 * asked, exactly as a client would: tools/list, resources/list,
 * resources/templates/list, prompts/list. Each tool carries its one-sentence
 * summary (the first paragraph of the five-heading description the server
 * sends — see src/tools/describe.ts); every resource and template carries
 * the description it was registered with. Install blocks are keyed by the
 * one public identifier (src/identity.ts). Brand facts come from
 * .claims.json; the version from package.json.
 *
 * Usage:
 *   npm run mcp-json:render      # render + write
 *   npm run mcp-json:check       # exit 1 if the committed file differs
 *
 * Runs under tsx (it imports the server's TypeScript directly), like the
 * proof runner. tests/mcp-json-contract.test.ts calls renderManifest() and
 * compares it to the committed file, so the check also runs in the suite.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../src/server.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { PRODUCT_NAME, PUBLIC_ID } from '../../src/identity.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

export const MANIFEST_PATH = 'website/public/.well-known/mcp.json';

export interface ManifestTool {
  name: string;
  /** The one-sentence summary: the first paragraph of the description the server sends. */
  description: string;
}
export interface ManifestResource {
  uri: string;
  name: string;
  description: string;
  /** True for a URI template (resources/templates/list), absent for a fixed resource. */
  template?: true;
}
export interface Manifest {
  name: string;
  id: string;
  description: string;
  homepage: string;
  repository: string;
  npm: string;
  version: string;
  license: string;
  transport: string[];
  tools: ManifestTool[];
  resources: ManifestResource[];
  prompts: Array<{ name: string; description: string }>;
  install: {
    claude_code: { command: string };
    claude_desktop: { mcpServers: Record<string, { command: string; args: string[] }> };
    cursor: { mcpServers: Record<string, { command: string; args: string[] }> };
    docker: { command: string };
  };
  links: { capabilities: string; proof: string; llms: string; security: string };
  discovery: string;
  dataResidency: string;
}

/** The first paragraph — the summary sentence every tool description opens with. */
export function firstParagraph(text: string | undefined): string {
  return (text ?? '').split(/\n\s*\n/)[0].trim();
}

export async function renderManifest(): Promise<Manifest> {
  const claims = JSON.parse(await readFile(resolve(root, '.claims.json'), 'utf-8')) as {
    brand: { tagline: string; websiteUrl: string; publicRepoUrl: string; npmPackage: string; discoverySentence: string; dataResidency: string };
  };
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf-8')) as { version: string; license: string };
  const { brand } = claims;

  const storage = new SqliteAdapter(':memory:');
  await storage.initialize();
  const { mcpServer } = createIrisServer(defaultConfig, storage);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: 'render-mcp-json', version: pkg.version });
  await client.connect(clientTransport);
  try {
    const tools: ManifestTool[] = (await client.listTools()).tools.map((t) => ({
      name: t.name,
      description: firstParagraph(t.description),
    }));
    const fixed: ManifestResource[] = (await client.listResources()).resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description ?? '',
    }));
    const templates: ManifestResource[] = (await client.listResourceTemplates()).resourceTemplates.map((r) => ({
      uri: r.uriTemplate,
      name: r.name,
      description: r.description ?? '',
      template: true,
    }));
    const prompts = (await client.listPrompts()).prompts.map((p) => ({ name: p.name, description: p.description ?? '' }));

    const npxBlock = { command: 'npx', args: [brand.npmPackage, '--dashboard'] };
    const image = brand.publicRepoUrl.replace(/^https:\/\/github\.com\//, 'ghcr.io/');
    return {
      name: PRODUCT_NAME,
      id: PUBLIC_ID,
      description: `${brand.tagline}. Score every agent output for quality, safety, and cost.`,
      homepage: brand.websiteUrl,
      repository: brand.publicRepoUrl,
      npm: brand.npmPackage,
      version: pkg.version,
      license: pkg.license,
      transport: ['stdio', 'http'],
      tools,
      resources: [...fixed, ...templates],
      prompts,
      install: {
        claude_code: { command: `claude mcp add ${PUBLIC_ID} -- npx ${brand.npmPackage} --dashboard` },
        claude_desktop: { mcpServers: { [PUBLIC_ID]: npxBlock } },
        cursor: { mcpServers: { [PUBLIC_ID]: npxBlock } },
        docker: {
          command: `docker run -p 3000:3000 -p 6920:6920 -v iris-data:/data -e IRIS_API_KEY=<your key> ${image}`,
        },
      },
      links: {
        capabilities: `${brand.websiteUrl}/capabilities`,
        proof: `${brand.websiteUrl}/proof`,
        llms: `${brand.websiteUrl}/llms.txt`,
        security: `${brand.websiteUrl}/.well-known/security.txt`,
      },
      discovery: brand.discoverySentence,
      dataResidency: brand.dataResidency,
    };
  } finally {
    await client.close();
    await mcpServer.close();
    await storage.close();
  }
}

export function serialize(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

const normalize = (s: string): string => s.replace(/\r\n/g, '\n');

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const text = serialize(await renderManifest());
  const target = resolve(root, MANIFEST_PATH);
  if (check) {
    let committed = '';
    try {
      committed = await readFile(target, 'utf-8');
    } catch {
      committed = '';
    }
    if (normalize(committed) !== normalize(text)) {
      console.error(`[mcp-json:check] FAIL — ${MANIFEST_PATH} differs from the render of the built server. Run: npm run mcp-json:render`);
      process.exit(1);
    }
    console.log(`[mcp-json:check] OK — ${MANIFEST_PATH} matches the built server`);
    return;
  }
  await writeFile(target, text, 'utf-8');
  console.log(`[mcp-json:render] wrote ${MANIFEST_PATH}`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
}
