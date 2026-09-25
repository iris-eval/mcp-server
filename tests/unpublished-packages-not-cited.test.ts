/**
 * Cite only what is published.
 *
 * Two in-repo npm packages once returned 404 from `npm view` while their
 * READMEs opened with `npx` / `npm install` commands that could not resolve
 * and a CI comment called one "a PUBLISHED npm package". The truthbase
 * records `version.published` for every package in the repository — derived
 * from each manifest by scripts/claims/packages.mjs, so no package is left
 * off a hand list — and this suite makes the record bind: every public
 * surface that shows an install command for an npm package that is not on
 * the registry must say, in the same file, that it is not yet published.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-ignore — plain .mjs module, no type declarations needed for a test
import { generate as generateVersion } from '../scripts/claims/generators/version.mjs';
// @ts-ignore — plain .mjs module
import { inventory } from '../scripts/claims/packages.mjs';

const ROOT = resolve(__dirname, '..');

type Entry = { manifest: string; dir: string; key: string; name: string | null; kind: string; published: boolean };
const PACKAGES = (inventory() as Entry[]).filter((p) => p.manifest.endsWith('package.json') && p.dir !== '.');

/** Truthbase key → package directory, for every npm package in the repository besides the server. */
const PACKAGE_DIRS: Record<string, string> = Object.fromEntries(PACKAGES.map((p) => [p.key, p.dir]));

/**
 * Everything a stranger can read: the repo's public prose and manifests.
 * For the in-repo packages that is their README and package.json — the
 * surfaces an npm page or a GitHub visitor sees — not their source: the
 * CLI's --help text is runtime behaviour reachable only after a from-source
 * build, whose README already carries the notice.
 */
const SURFACE_FILES = ['README.md', 'server.json'];
const SURFACE_DIRS = [
  'docs',
  'examples',
  'skills',
  'claude-plugin',
  '.claude-plugin',
  'website/src',
  'website/public',
  '.github/workflows',
  '.github/actions',
];
const SURFACE_EXT = new Set(['.md', '.mdx', '.txt', '.json', '.ts', '.tsx', '.mjs', '.yml', '.yaml']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', 'coverage', '__snapshots__']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if ([...SURFACE_EXT].some((ext) => entry.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

function surfaceFiles(): string[] {
  const files = SURFACE_FILES.map((f) => resolve(ROOT, f));
  for (const dir of SURFACE_DIRS) files.push(...walk(resolve(ROOT, dir)));
  for (const dir of Object.values(PACKAGE_DIRS)) {
    files.push(resolve(ROOT, dir, 'README.md'), resolve(ROOT, dir, 'package.json'));
  }
  return files;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** `npx <pkg>`, `npm install <pkg>`, `npm i <pkg>`, `pnpm add <pkg>`, `yarn add <pkg>`, `bunx <pkg>` … */
function installCommandRe(pkg: string): RegExp {
  return new RegExp(
    String.raw`\b(?:npx|bunx|npm\s+(?:install|i|add)|pnpm\s+(?:add|dlx)|yarn\s+(?:add|dlx)|bun\s+add)\s+(?:-{1,2}[\w-]+\s+)*${escapeRe(pkg)}(?![\w/-])`,
  );
}

const claims = JSON.parse(readFileSync(resolve(ROOT, '.claims.json'), 'utf-8')) as {
  version: { published: Record<string, boolean> };
};

describe('unpublished packages are never presented as installable', () => {
  it('.claims.json carries the generator\'s published map, key for key', async () => {
    const generated = (await generateVersion()) as { published: Record<string, boolean> };
    expect(claims.version.published).toEqual(generated.published);
    // Every in-repo package has a verdict; the server itself is the one
    // that is on the registry.
    for (const key of Object.keys(PACKAGE_DIRS)) expect(typeof claims.version.published[key]).toBe('boolean');
    expect(claims.version.published.mcpServer).toBe(true);
  });

  const unpublished = Object.entries(PACKAGE_DIRS)
    .filter(([key]) => claims.version.published[key] === false)
    .map(([, dir]) => {
      const pkg = JSON.parse(readFileSync(resolve(ROOT, dir, 'package.json'), 'utf-8')) as { name: string };
      return { dir, name: pkg.name, kind: PACKAGES.find((p) => p.dir === dir)!.kind };
    });

  it('the inventory found the in-repo npm packages that are not on the registry', () => {
    // The walk itself is guarded: a regression that found nothing would pass every check below vacuously.
    expect(unpublished.map((p) => p.dir).sort()).toEqual(PACKAGES.filter((p) => !p.published).map((p) => p.dir).sort());
    expect(unpublished.length).toBeGreaterThan(0);
  });

  it.each(unpublished)('$name: every surface that shows an install command says it is not yet published', ({ name, dir, kind }) => {
    const re = installCommandRe(name);
    const offenders: string[] = [];
    // The launcher is published by hand from its own folder, so its README
    // and manifest are what npm will show: they describe the package as it
    // will be, and are not surfaces that could send a reader to it early.
    const own = kind === 'launcher' ? [resolve(ROOT, dir, 'README.md'), resolve(ROOT, dir, 'package.json')] : [];
    for (const file of surfaceFiles().filter((f) => !own.includes(f))) {
      const text = readFileSync(file, 'utf-8');
      if (!re.test(text)) continue;
      if (!/not yet published/i.test(text)) offenders.push(relative(ROOT, file));
    }
    expect(offenders, `files presenting ${name} as installable without saying it is unpublished`).toEqual([]);
  });

  it.each(unpublished)('$name: no surface calls it a published package', ({ name }) => {
    const re = new RegExp(String.raw`\bPUBLISHED\s+npm\s+package\b[^\n]{0,80}${escapeRe(name)}`, 'i');
    const offenders = surfaceFiles()
      .filter((file) => re.test(readFileSync(file, 'utf-8')))
      .map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('the truthbase README documents the field', () => {
    const text = readFileSync(resolve(ROOT, 'scripts', 'claims', 'README.md'), 'utf-8');
    expect(text).toMatch(/version\.published|`published`/);
  });
});
