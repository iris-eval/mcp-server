/**
 * Cite only what is published.
 *
 * `@iris-eval/init` and `@iris-eval/langchain` return 404 from `npm view`:
 * they live in this repo, build and test in CI, and have never been
 * published — yet a CI comment called one "a PUBLISHED npm package" and both
 * READMEs opened with `npx` / `npm install` commands that cannot resolve.
 * The truthbase now records `version.published` per package (a static,
 * dated decision in scripts/claims/generators/version.mjs — the generator
 * runs offline and must not probe the registry). This suite makes the record
 * bind: every public surface that shows an install command for an
 * unpublished package must say, in the same file, that it is not yet
 * published. Publish-or-retire is the founder's decision; until it is made,
 * no surface lies.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-ignore — plain .mjs module, no type declarations needed for a test
import { generate as generateVersion } from '../scripts/claims/generators/version.mjs';

const ROOT = resolve(__dirname, '..');

/** Truthbase key → package directory; the npm name is read from package.json. */
const PACKAGE_DIRS: Record<string, string> = {
  initPackage: 'packages/init',
  langchainPackage: 'packages/langchain',
};

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
      return { dir, name: pkg.name };
    });

  it.each(unpublished)('$name: every surface that shows an install command says it is not yet published', ({ name }) => {
    const re = installCommandRe(name);
    const offenders: string[] = [];
    for (const file of surfaceFiles()) {
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
