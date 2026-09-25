// Version generator — the version of every package in the repository.
//
// Output shape: { mcpServer, <dir>Package… for every package in the inventory,
// websitePackage, dashboardPackage, published }
//
// The packages come from ../packages.mjs, which enumerates every package.json
// and pyproject.toml and classifies each from its own manifest (released by
// release.yml, released by publish-python.yml, "private": true, or the
// `iris-eval` launcher) — never from a hand list, so a package added later
// is covered the moment it exists. `published` says, per package, whether it
// is on its registry: true for the two that a workflow publishes, false for a
// private package, and the recorded fact for the launcher (the generator
// runs offline and must not probe a registry). No public surface may present
// a package with `published: false` as installable;
// tests/unpublished-packages-not-cited.test.ts walks every surface for each.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventory } from '../packages.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

async function readVersion(pkgPath) {
  try {
    const raw = await readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw);
    return pkg.version ?? null;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function generate() {
  const packages = inventory(root);
  const versions = Object.fromEntries(packages.map((p) => [p.key, p.version]));
  const published = Object.fromEntries(packages.map((p) => [p.key, p.published]));
  return {
    ...versions,
    websitePackage: await readVersion(resolve(root, 'website/package.json')),
    dashboardPackage: await readVersion(resolve(root, 'dashboard/package.json')),
    published,
  };
}
