/*
 * One identifier — the lock for src/identity.ts.
 *
 * Every machine-read name (config key, plugin name, skill name, compose
 * service, OTel default, command) equals PUBLIC_ID, and no surface a reader
 * copies from still shows the old key or the old command. The blog and the
 * launch drafts keep their period prose, but a config BLOCK inside them is
 * an instruction that gets pasted, so those keys are held to this too.
 * Proven to bite by planting "iris" back into .mcp.json once.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMAND, LEGACY_COMMAND, PUBLIC_ID } from '../src/identity.js';
import { DEFAULT_OTEL_SERVICE_NAME } from '../src/otel/exporter.js';

const root = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const rel = (abs: string): string => abs.slice(root.length + 1).split('\\').join('/');
const frontMatterName = (text: string): string | undefined => text.match(/^---\n(?:[^\n]*\n)*?name:\s*([a-z0-9-]+)/)?.[1];

describe('one identifier', () => {
  it('the constant is the one the well-known manifest and the README already used', () => {
    expect(PUBLIC_ID).toBe('iris-eval');
    expect(COMMAND).toBe(PUBLIC_ID);
    expect(LEGACY_COMMAND).not.toBe(PUBLIC_ID);
  });

  it('every machine-read name equals PUBLIC_ID', () => {
    expect(Object.keys(JSON.parse(read('.mcp.json')).mcpServers)).toEqual([PUBLIC_ID]);
    expect(Object.keys(JSON.parse(read('claude-plugin/.mcp.json')).mcpServers)).toEqual([PUBLIC_ID]);
    expect(JSON.parse(read('.claude-plugin/plugin.json')).name).toBe(PUBLIC_ID);
    expect(JSON.parse(read('claude-plugin/.claude-plugin/plugin.json')).name).toBe(PUBLIC_ID);
    const marketplace = JSON.parse(read('.claude-plugin/marketplace.json')) as { name: string; plugins: Array<{ name: string }> };
    expect(marketplace.name).toBe(PUBLIC_ID);
    expect(marketplace.plugins.map((p) => p.name)).toContain(PUBLIC_ID);
    expect(frontMatterName(read('skills/iris-eval/SKILL.md'))).toBe(PUBLIC_ID);
    expect(frontMatterName(read('claude-plugin/skills/iris-eval/SKILL.md'))).toBe(PUBLIC_ID);
    expect(read('docker-compose.yml')).toMatch(new RegExp(`^  ${PUBLIC_ID}:`, 'm'));
    expect(DEFAULT_OTEL_SERVICE_NAME).toBe(PUBLIC_ID);
    const bin = JSON.parse(read('package.json')).bin as Record<string, string>;
    expect(bin[COMMAND]).toBe('dist/index.js');
    expect(bin[LEGACY_COMMAND]).toBe('dist/index.js'); // still installed, undocumented
  });

  it('no surface a reader copies from shows the old config key', () => {
    const files = [
      join(root, 'README.md'),
      join(root, '.mcp.json'),
      ...['docs', 'website/src', 'examples', 'skills', 'claude-plugin', '.claude-plugin'].flatMap((d) => walk(join(root, d))),
    ].filter((f) => /\.(md|mdx|json|tsx?|txt|ya?ml|py)$/.test(f) && !/\.template\./.test(f));
    expect(files.length).toBeGreaterThan(40); // the extractor found the surfaces
    const stale = files.filter((f) => /"iris"\s*:/.test(readFileSync(f, 'utf8'))).map(rel);
    expect(stale).toEqual([]);
  });

  it('no live surface documents the legacy command', () => {
    const live = [
      'README.md', 'server.json', 'docker-compose.yml', 'smithery.yaml', 'src/index.ts', 'skills/iris-eval/SKILL.template.md',
      ...readdirSync(join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`),
      ...walk(join(root, 'website', 'src')).map(rel),
      ...walk(join(root, 'claude-plugin')).map(rel),
      ...walk(join(root, '.claude-plugin')).map(rel),
    ];
    expect(live.length).toBeGreaterThan(20);
    const stale = live.filter((r) => read(r).includes(LEGACY_COMMAND));
    expect(stale).toEqual([]);
  });

  it('the legacy command is still a bin, so an existing config keeps running', () => {
    expect(read('src/identity.ts')).toContain(`LEGACY_COMMAND = '${LEGACY_COMMAND}'`);
  });
});
