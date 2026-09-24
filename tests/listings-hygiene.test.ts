/*
 * Every listing inherits the truth: the registry manifest
 * validates against the vendored 2025-12-11 schema with the three display
 * fields present and pointing at files the site serves; the README carries
 * the demo GIF (under three megabytes, its source beside it), the install
 * buttons in their current forms registering the server as `iris-eval`,
 * the mcp.so badge on the listing's real address, and a works-with table
 * that is clients.json rendered; the Docker catalog entry names only what
 * the manifest names; the Cursor plugin manifest is on the version gates;
 * the site's mockups say the real port; the historical launch drafts say
 * "do not repost"; smithery.yaml is gone with its reason on record.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv from 'ajv';

const root = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const readme = read('README.md');
const serverJson = JSON.parse(read('server.json')) as {
  title?: string;
  websiteUrl?: string;
  icons?: Array<{ src: string; mimeType?: string; sizes?: string[] }>;
  packages: Array<{ environmentVariables?: Array<{ name: string }> }>;
};
const claims = JSON.parse(read('.claims.json')) as { clients: { rows: Array<{ name: string; status: string; lastChecked: string }> }; brand: { websiteUrl: string } };
const pkg = JSON.parse(read('package.json')) as { version: string };

describe('server.json — the registry manifest', () => {
  it('validates against the 2025-12-11 schema, vendored, with title, websiteUrl and icons present', () => {
    const schema = JSON.parse(read('schemas/mcp-server.schema.2025-12-11.json')) as Record<string, unknown>;
    expect(schema.$id).toBe('https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json');
    // The schema's own `format` words (uri, date-time) are not validated here; ajv-formats is not a dependency and the shape is the contract.
    const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
    const validate = ajv.compile(schema);
    const ok = validate(serverJson);
    expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(serverJson.title).toBe('Iris');
    expect(serverJson.websiteUrl).toBe(claims.brand.websiteUrl);
    expect(serverJson.icons?.map((i) => i.mimeType)).toEqual(['image/svg+xml', 'image/png']);
  });

  it('each icon is a file the site serves, at the size it says', () => {
    for (const icon of serverJson.icons ?? []) {
      expect(icon.src.startsWith(`${claims.brand.websiteUrl}/`), icon.src).toBe(true);
      const rel = join('website', 'public', icon.src.slice(claims.brand.websiteUrl.length + 1));
      expect(existsSync(join(root, rel)), rel).toBe(true);
      if (icon.mimeType === 'image/png') {
        const buf = readFileSync(join(root, rel));
        expect(`${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`).toBe(icon.sizes?.[0]);
      }
    }
  });
});

describe('the README', () => {
  it('opens on the demo GIF, under three megabytes, with its MP4 source on the site', () => {
    expect(readme).toContain('](https://raw.githubusercontent.com/iris-eval/mcp-server/main/docs/assets/demo.gif)');
    const gif = join(root, 'docs', 'assets', 'demo.gif');
    expect(existsSync(gif)).toBe(true);
    expect(statSync(gif).size).toBeLessThanOrEqual(3 * 1024 * 1024);
    expect(readFileSync(gif).subarray(0, 6).toString('latin1')).toMatch(/^GIF8[79]a$/);
    const mp4 = join(root, 'website', 'public', 'demo.mp4');
    expect(existsSync(mp4)).toBe(true);
    expect(statSync(mp4).size).toBeGreaterThan(10_000);
    expect(readme).toContain('https://iris-eval.com/demo.mp4');
    // The GIF comes before the first section heading: the top of the page.
    expect(readme.indexOf('docs/assets/demo.gif')).toBeLessThan(readme.indexOf('\n## '));
  });

  it('carries the Cursor and VS Code install buttons in their current forms, each registering the server as iris-eval', () => {
    const cursor = readme.match(/\[!\[Install in Cursor\]\([^)]+\)\]\((https:\/\/cursor\.com\/install-mcp\?name=iris-eval&config=([A-Za-z0-9+/=]+))\)/);
    expect(cursor, 'the Cursor button').not.toBeNull();
    const cursorConfig = JSON.parse(Buffer.from(cursor![2], 'base64').toString('utf8')) as { command: string; args: string[] };
    expect(cursorConfig).toEqual({ command: 'npx', args: ['-y', '@iris-eval/mcp-server'] });
    const vscode = readme.match(/\[!\[Install in VS Code\]\([^)]+\)\]\((https:\/\/vscode\.dev\/redirect\/mcp\/install\?name=iris-eval&config=([^)]+))\)/);
    expect(vscode, 'the VS Code button').not.toBeNull();
    const vscodeConfig = JSON.parse(decodeURIComponent(vscode![2])) as { name: string; command: string; args: string[] };
    expect(vscodeConfig).toEqual({ name: 'iris-eval', command: 'npx', args: ['-y', '@iris-eval/mcp-server'] });
    expect(readme).not.toContain('cursor://anysphere.cursor-deeplink');
  });

  it('the mcp.so badge points at the listing\'s real address, the one its copy names', () => {
    expect(readme).toContain('](https://mcp.so/servers/mcp-server-iris-eval)');
    expect(readme).not.toContain('mcp.so/server/iris/iris-eval');
    expect(read('docs/launch/listings/mcp-so.md')).toContain('https://mcp.so/servers/mcp-server-iris-eval');
  });

  it('the works-with table is clients.json, rendered: one row per client with its status and the date it was read', () => {
    const block = readme.match(/<!-- iris:clients-table:start -->\n([\s\S]*?)\n<!-- iris:clients-table:end -->/);
    expect(block, 'the clients-table block').not.toBeNull();
    const rows = block![1]
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| Client') && !l.startsWith('|---'))
      .map((l) => l.split('|').map((c) => c.trim()));
    expect(rows.map((r) => [r[1], r[2]])).toEqual(claims.clients.rows.map((r) => [r.name, r.status]));
    for (const [i, r] of rows.entries()) expect(r[4], r[1]).toContain(`[${claims.clients.rows[i].lastChecked}](`);
  });
});

describe('the other listings', () => {
  it('the Docker catalog entry names the published image, the site\'s icon, and only variables the manifest lists', () => {
    const yaml = read('docs/launch/listings/docker/server.yaml');
    expect(yaml).toMatch(/^name: iris-eval$/m);
    expect(yaml).toMatch(/^image: ghcr\.io\/iris-eval\/mcp-server$/m);
    expect(yaml).toMatch(/^type: server$/m);
    expect(yaml).toMatch(/^  project: https:\/\/github\.com\/iris-eval\/mcp-server$/m);
    expect(yaml).toMatch(/^  icon: https:\/\/iris-eval\.com\/iris-logo-white-bg\.png$/m);
    expect(yaml).toContain('description: Stop shipping agents on vibes. Score every agent output for quality, safety, and cost.');
    const listed = new Set(serverJson.packages.flatMap((p) => (p.environmentVariables ?? []).map((e) => e.name)));
    const named = [...yaml.matchAll(/^\s+env: (IRIS_[A-Z0-9_]+)$/gm), ...yaml.matchAll(/^\s+- name: (IRIS_[A-Z0-9_]+)$/gm)].map((m) => m[1]);
    expect(named.length).toBeGreaterThanOrEqual(4);
    expect(named.filter((n) => !listed.has(n))).toEqual([]);
    expect(read('docs/launch/listings/docker.md')).toContain('docker/server.yaml');
    expect(read('docs/launch/listings/README.md')).toContain('| Docker MCP Catalog |');
  });

  it('the Cursor plugin manifest installs this repository as a plugin and is on both version gates', () => {
    const manifest = JSON.parse(read('.cursor-plugin/plugin.json')) as { name: string; version: string; logo: string; mcpServers: Record<string, { command: string; args: string[] }> };
    expect(manifest.name).toBe('iris-eval');
    expect(manifest.version).toBe(pkg.version);
    expect(existsSync(join(root, manifest.logo))).toBe(true);
    // Pinned to this release (2026-09-23, SUP-6), rolled by version:sync and walked by check-version.
    expect(manifest.mcpServers['iris-eval']).toMatchObject({ command: 'npx', args: ['-y', `@iris-eval/mcp-server@${pkg.version}`] });
    expect(read('scripts/check-version.sh')).toContain('check_version ".cursor-plugin/plugin.json" ".version"');
    expect(read('scripts/sync-versions.mjs')).toContain('path: ".cursor-plugin/plugin.json"');
  });

  it('smithery.yaml is gone, and the listing copy says why', () => {
    expect(existsSync(join(root, 'smithery.yaml'))).toBe(false);
    const copy = read('docs/launch/listings/smithery.md');
    expect(copy).toContain('**Listing:** retired');
    expect(copy).toContain('smithery mcp publish');
    expect(read('docs/launch/listings/README.md')).toMatch(/\| Smithery \| `smithery\.md` \| retired/);
  });

  it('the site\'s mockups show the real dashboard port', () => {
    for (const rel of ['website/src/components/playground/act-three.tsx', 'website/src/components/dashboard-mockup.tsx']) {
      const text = read(rel);
      expect(text, rel).not.toContain('3838');
      expect(text, rel).toContain('localhost:6920');
    }
  });

  it('every historical launch draft opens on its banner and says not to repost it, so "first" is never posted again', () => {
    const drafts = readdirSync(join(root, 'docs', 'launch')).filter((f) => f.endsWith('.md') && !f.includes('template') && f !== 'release-checklist.md');
    expect(drafts.sort()).toEqual(['demo-script-60s.md', 'demo-script.md', 'mcp-community-post.md', 'reddit-posts.md', 'show-hn-draft.md', 'twitter-thread.md']);
    for (const f of drafts) {
      const head = read(`docs/launch/${f}`).split('\n').slice(0, 6).join('\n');
      expect(head, f).toMatch(/📁 Historical/);
      expect(head, f).toMatch(/do not (re)?post|must be composed fresh|must be rebuilt|reference only|Kept for record/i);
    }
  });
});
