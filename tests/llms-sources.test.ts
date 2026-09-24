/*
 * The llms files take their lists from the sources the site and the server
 * use, not from prose.
 *
 * llms.txt listed eight compare pages after the site had fourteen, and
 * llms-full.txt described tools the way they worked releases earlier (nine of
 * twelve, list_rules as "custom rules only"), with a Docker command missing
 * the dashboard port and install snippets unlike the README's. Both lists
 * were typed into the templates. Now the compare list renders from
 * website/src/lib/compare/index.ts (the registry the compare index, the
 * sitemap and the pages read) and the tool list from the discovery manifest
 * (rendered from the built server's tools/list, held to it by
 * tests/mcp-json-contract.test.ts). This file pins the outputs to those
 * sources and pins one install form on every rendered surface: `npx -y` and
 * the package at the current release.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareEntries, manifestTools } from '../scripts/claims/render-llms.mjs';

const root = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const pkg = JSON.parse(read('package.json')) as { name: string; version: string };
const llms = read('website/public/llms.txt');
const llmsFull = read('website/public/llms-full.txt');
const manifestText = read('website/public/.well-known/mcp.json');
const manifest = JSON.parse(manifestText) as {
  tools: Array<{ name: string; description: string }>;
  install: Record<string, unknown>;
};

describe('the compare list in the llms files is the compare registry', () => {
  it('reads every registry entry, in the order the site lists them', async () => {
    const entries = (await compareEntries(root)) as Array<{ slug: string; name: string }>;
    const index = read('website/src/lib/compare/index.ts');
    const files = [...index.matchAll(/from "\.\/([a-z0-9-]+)\.json"/g)].map((m) => m[1]).sort();
    expect(entries.map((e) => e.slug).sort()).toEqual(files);
    expect(new Set(entries.map((e) => e.slug)).size).toBe(entries.length);
  });

  it('llms.txt links every compare page and no page the registry lacks', async () => {
    const entries = (await compareEntries(root)) as Array<{ slug: string; name: string }>;
    const linked = [...llms.matchAll(/\]\(https:\/\/iris-eval\.com\/compare\/([a-z0-9-]+)\)/g)].map((m) => m[1]);
    expect(linked).toEqual(entries.map((e) => e.slug));
  });

  it('llms-full.txt names every compared product', async () => {
    const entries = (await compareEntries(root)) as Array<{ slug: string; name: string }>;
    const line = llmsFull.split('\n').find((l) => l.startsWith('- Comparisons:'));
    expect(line).toBeDefined();
    for (const e of entries) expect(line, e.slug).toContain(e.name);
  });
});

describe('the tool list in llms-full.txt is the server\'s', () => {
  it('lists every tool the manifest lists, with the summary the server sends, and no other', async () => {
    const tools = (await manifestTools(root)) as Array<{ name: string; description: string }>;
    expect(tools).toEqual(manifest.tools);
    const listed = [...llmsFull.matchAll(/^\d+\. `([a-z_]+)` — (.+)$/gm)].map((m) => ({ name: m[1], description: m[2] }));
    expect(listed).toEqual(tools);
    expect(llmsFull).toContain(`## MCP tools (${tools.length})`);
  });
});

describe('the runtime floor in llms-full.txt is package.json engines', () => {
  it('states the floor npm enforces', () => {
    const engines = (JSON.parse(read('package.json')) as { engines: { node: string } }).engines.node;
    const floor = engines.replace(/^>=\s*/, '').replace(/\.0$/, '');
    expect(llmsFull).toContain(`- Requires Node.js ${floor} or later`);
  });
});

describe('one install form on every rendered surface', () => {
  const pinned = `${pkg.name}@${pkg.version}`;

  it('every npx install names -y and the package at the current release', () => {
    for (const [file, text] of [
      ['llms.txt', llms],
      ['llms-full.txt', llmsFull],
      ['mcp.json', manifestText],
    ] as const) {
      // A command line: npx followed by the package.
      const commands = [...text.matchAll(/npx ((?:-y )?)(@iris-eval\/mcp-server(?:@[0-9A-Za-z.+-]+)?)/g)];
      // A config block: "npx" as the command and the args array after it.
      const argsArrays = [...text.matchAll(/"args":\s*\[\s*([^\]]*)\]/g)].map((m) => m[1].replace(/\s+/g, ' '));
      const toml = [...text.matchAll(/^\s*args = \[([^\]]*)\]/gm)].map((m) => m[1]);
      expect(commands.length + argsArrays.length + toml.length, file).toBeGreaterThan(0);
      for (const m of commands) {
        expect(m[1], `${file}: ${m[0]}`).toBe('-y ');
        expect(m[2], `${file}: ${m[0]}`).toBe(pinned);
      }
      for (const a of [...argsArrays, ...toml]) {
        expect(a, `${file}: ${a}`).toMatch(new RegExp(`^"-y", "${pinned.replace(/[.@/]/g, '\\$&')}"`));
      }
    }
  });

  it('every docker run publishes both ports, sets the key the image requires, and pins the image to the release', () => {
    for (const [file, text] of [
      ['llms-full.txt', llmsFull],
      ['mcp.json', manifestText],
    ] as const) {
      const runs = [...text.matchAll(/docker run [^\n"]*(?:"[^"\n]*"[^\n"]*)*/g)].map((m) => m[0]);
      expect(runs.length, file).toBeGreaterThan(0);
      for (const r of runs) {
        expect(r, file).toContain('-p 3000:3000');
        expect(r, file).toContain('-p 6920:6920');
        expect(r, file).toContain('-e IRIS_API_KEY=');
        expect(r, file).toContain(`ghcr.io/iris-eval/mcp-server:v${pkg.version}`);
      }
    }
  });
});
