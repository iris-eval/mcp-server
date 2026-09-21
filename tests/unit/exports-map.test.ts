/*
 * The exports map promises only what the tree can keep (arc 8, R-1).
 *
 * `package.json` declares `.`, `./engine`, `./client`, a `./dist/*`
 * passthrough and the two manifests. This holds the map's shape, that
 * every mapped entry has a source under src/ to build from, and that the
 * engine barrel stays free of the storage layer, the servers and the CLI
 * — an embedder importing `./engine` must get an engine, not a listener.
 * The packed-and-installed proof is scripts/check-exports.mjs in CI.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REQUIRED_ARTIFACTS } from '../../scripts/check-pack.mjs';

const root = resolve(__dirname, '..', '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { main: string; types: string; exports: Record<string, string | { types: string; default: string }> };

describe('the exports map', () => {
  it('declares the package root, the engine, the client, the dist passthrough and the manifests', () => {
    expect(Object.keys(pkg.exports)).toEqual(['.', './engine', './client', './dist/*', './package.json', './server.json']);
    expect(pkg.exports['.']).toEqual({ types: './dist/index.d.ts', default: './dist/index.js' });
    expect(pkg.exports['./engine']).toEqual({ types: './dist/engine.d.ts', default: './dist/engine.js' });
    expect(pkg.exports['./client']).toEqual({ types: './dist/client.d.ts', default: './dist/client.js' });
    expect(pkg.exports['./dist/*']).toBe('./dist/*');
    // The root export and `main` agree, so an old-style require and a modern import land on one file.
    expect((pkg.exports['.'] as { default: string }).default).toBe(`./${pkg.main}`);
  });

  it('every conditional entry has a TypeScript source to build from, and the prepack guard requires its output', () => {
    for (const [sub, target] of Object.entries(pkg.exports)) {
      if (typeof target === 'string') continue;
      const src = target.default.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts');
      expect(existsSync(join(root, src)), `${sub} → ${src}`).toBe(true);
      expect(REQUIRED_ARTIFACTS, `${sub} in REQUIRED_ARTIFACTS`).toContain(target.default.replace(/^\.\//, ''));
    }
  });

  it('the engine barrel imports no storage, no server, no dashboard and no CLI', () => {
    const barrel = readFileSync(join(root, 'src', 'engine.ts'), 'utf8');
    const imports = [...barrel.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(8);
    for (const i of imports) {
      expect(i, i).not.toMatch(/storage|dashboard|transport|\.\/index\.js|\.\/server\.js|middleware|better-sqlite3|express/);
    }
  });

  it('the client depends on types alone', () => {
    const client = readFileSync(join(root, 'src', 'client.ts'), 'utf8');
    const runtimeImports = [...client.matchAll(/^import (?!type)[^;]+from '([^']+)'/gm)].map((m) => m[1]);
    expect(runtimeImports).toEqual([]);
  });
});
