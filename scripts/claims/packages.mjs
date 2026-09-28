// Package inventory — every package manifest in the repository, and what
// releases it.
//
// A package in this repository is exactly one of:
//   release      the root package.json, @iris-eval/mcp-server, which
//                .github/workflows/release.yml packs and publishes to npm;
//   pypi         packages/python/pyproject.toml, the Python client, which
//                .github/workflows/publish-python.yml builds and publishes;
//   npm          a library in NPM_PACKAGE_DIRS (the JavaScript SDK and the
//                LangChain.js handler), which release.yml's build-packages
//                job builds and packs and its publish-packages job publishes
//                to npm with provenance, when its version is not on npm yet;
//   private      a package.json marked "private": true — npm refuses to
//                publish it;
//   launcher     packages/iris-eval, the unscoped npm name `iris-eval`:
//                it depends on the server alone, at LAUNCHER_SERVER_RANGE,
//                an open-ended range, and starts it, so `npx iris-eval`
//                runs the server's latest release. Its version is pinned at
//                LAUNCHER_VERSION and it runs no scripts, so it needs a
//                release only when the launcher itself changes; release.yml
//                publishes it the way it publishes the npm kind.
// Anything else is unclassified, and tests/package-inventory.test.ts fails on
// it. That is the point: two in-repo packages once sat for weeks with install
// commands on public surfaces, CI jobs building them and publish workflows
// that could no longer publish, because nothing asked which of these each
// package was. The classification is read from the manifests themselves, not
// from a list here, so a new package cannot escape it.
//
// The generator runs offline, so whether a package is on the registry is a
// recorded fact, not a probe: LAUNCHER_PUBLISHED and NPM_PUBLISHED. Flip one
// in the PR that follows the release that first published it.
// iris-eval@1.0.0 was published by hand on 2026-09-26 (`npm view iris-eval
// version` → 1.0.0), without provenance; 1.0.1 is the same launcher, published
// by release.yml with provenance.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..', '..');

export const LAUNCHER_DIR = 'packages/iris-eval';
export const LAUNCHER_VERSION = '1.0.1';
/** The first server release with `install`; open-ended so the launcher never needs a release. */
export const LAUNCHER_SERVER_RANGE = '>=0.19.0';
export const LAUNCHER_PUBLISHED = true;
export const PYPI_DIR = 'packages/python';
/** The libraries release.yml publishes to npm, in publish order: a package comes after every package it depends on. */
export const NPM_PACKAGE_DIRS = ['packages/sdk', 'packages/langchain'];
/** Whether each is on the registry: a recorded fact (see above). */
export const NPM_PUBLISHED = { 'packages/sdk': false, 'packages/langchain': false };

/** Top-level directories that are not packages Iris ships: the site, the dashboard SPA (built into the server) and examples. */
export const EXCLUDED_TOP_LEVEL = new Set(['website', 'dashboard', 'examples']);
const SKIP_ANYWHERE = new Set(['node_modules', 'dist', 'build', 'coverage']);

const MANIFESTS = new Set(['package.json', 'pyproject.toml']);
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies'];

/** Every package.json / pyproject.toml under the root, as forward-slash paths relative to it. */
export function findManifests(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = relative(root, full).split(sep).join('/');
      if (statSync(full).isDirectory()) {
        if (entry.startsWith('.') || SKIP_ANYWHERE.has(entry)) continue;
        if (dir === root && EXCLUDED_TOP_LEVEL.has(entry)) continue;
        walk(full);
      } else if (MANIFESTS.has(entry)) {
        out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** `version = "x"` from a pyproject.toml's [project] table. */
function pyprojectVersion(text) {
  const project = text.split(/^\[/m).find((s) => s.startsWith('project]'));
  return project?.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

function pyprojectName(text) {
  const project = text.split(/^\[/m).find((s) => s.startsWith('project]'));
  return project?.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

/** The truthbase key for a package: `mcpServer` for the root, `<dirName>Package` otherwise (packages/langchain → langchainPackage). */
export function keyFor(dir) {
  if (dir === '.') return 'mcpServer';
  const camel = basename(dir).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
  return `${camel}Package`;
}

/**
 * One manifest, classified from what it says. Returns
 * { manifest, dir, key, name, version, kind, published, reason? } where kind
 * is release | pypi | private | launcher | unclassified.
 */
export function classify(manifest, root = ROOT) {
  const text = readFileSync(join(root, manifest), 'utf-8');
  const dir = dirname(manifest) === '.' ? '.' : dirname(manifest);
  const base = { manifest, dir, key: keyFor(dir) };

  if (manifest.endsWith('pyproject.toml')) {
    const name = pyprojectName(text);
    const version = pyprojectVersion(text);
    if (dir === PYPI_DIR) return { ...base, name, version, kind: 'pypi', published: true };
    return { ...base, name, version, kind: 'unclassified', published: false, reason: `a Python package outside ${PYPI_DIR}, which is the only one publish-python.yml builds` };
  }

  const pkg = JSON.parse(text);
  const common = { ...base, name: pkg.name ?? null, version: pkg.version ?? null };
  if (dir === '.') return { ...common, kind: 'release', published: true };
  if (pkg.private === true) return { ...common, kind: 'private', published: false };
  if (NPM_PACKAGE_DIRS.includes(dir)) return { ...common, kind: 'npm', published: NPM_PUBLISHED[dir] === true };
  if (dir === LAUNCHER_DIR) {
    const server = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;
    const fields = DEPENDENCY_FIELDS.filter((f) => pkg[f] !== undefined);
    const deps = pkg.dependencies ?? {};
    if (fields.join() !== 'dependencies' || Object.keys(deps).join() !== server || deps[server] !== LAUNCHER_SERVER_RANGE) {
      return { ...common, kind: 'unclassified', published: false, reason: `the launcher must depend on ${server}@${LAUNCHER_SERVER_RANGE} and nothing else` };
    }
    if (pkg.version !== LAUNCHER_VERSION) return { ...common, kind: 'unclassified', published: false, reason: `the launcher is pinned at ${LAUNCHER_VERSION}; it says ${pkg.version}` };
    if (pkg.scripts !== undefined) return { ...common, kind: 'unclassified', published: false, reason: 'the launcher must run no scripts' };
    return { ...common, kind: 'launcher', published: LAUNCHER_PUBLISHED };
  }
  return { ...common, kind: 'unclassified', published: false, reason: 'not the released server, not the PyPI client, not an npm library release.yml publishes, not "private": true and not the launcher' };
}

export function inventory(root = ROOT) {
  return findManifests(root).map((m) => classify(m, root));
}

