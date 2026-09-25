/*
 * Every package in the repository is exactly one thing.
 *
 * scripts/claims/packages.mjs walks every package.json and pyproject.toml
 * (not node_modules, and not archive/, website/, dashboard/ or examples/,
 * which ship nothing on a registry of their own) and classifies each from its
 * own manifest: the server release.yml publishes to npm, the Python client
 * publish-python.yml publishes to PyPI, a "private": true package, or the
 * frozen `iris-eval` placeholder. This suite fails on anything else, and
 * checks the workflows really do what the classification says — two in-repo
 * packages once had install commands on public surfaces, CI jobs building
 * them and publish workflows that could not publish, because nothing asked
 * which of these each one was.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-ignore — plain .mjs module
import { PLACEHOLDER_DIR, PLACEHOLDER_VERSION, PYPI_DIR, findManifests, inventory } from '../scripts/claims/packages.mjs';

const ROOT = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

type Entry = { manifest: string; dir: string; key: string; name: string | null; version: string | null; kind: string; published: boolean; reason?: string };
const packages = inventory() as Entry[];
const workflows = readdirSync(join(ROOT, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f));

describe('the package inventory', () => {
  it('classifies every manifest in the repository as release, pypi, private or placeholder', () => {
    const unclassified = packages.filter((p) => p.kind === 'unclassified').map((p) => `${p.manifest}: ${p.reason}`);
    expect(unclassified).toEqual([]);
  });

  it('walks the tree it says it walks: the server, the Python client and the placeholder are found, excluded directories are not', () => {
    const manifests = findManifests() as string[];
    expect(manifests).toContain('package.json');
    expect(manifests).toContain(`${PYPI_DIR}/pyproject.toml`);
    expect(manifests).toContain(`${PLACEHOLDER_DIR}/package.json`);
    for (const m of manifests) expect(m, m).not.toMatch(/^(archive|website|dashboard|examples)\/|(^|\/)node_modules\//);
  });

  it('has exactly one package of each released kind', () => {
    expect(packages.filter((p) => p.kind === 'release').map((p) => p.dir)).toEqual(['.']);
    expect(packages.filter((p) => p.kind === 'pypi').map((p) => p.dir)).toEqual([PYPI_DIR]);
    expect(packages.filter((p) => p.kind === 'placeholder').map((p) => p.dir)).toEqual([PLACEHOLDER_DIR]);
  });

  it('the placeholder has no dependencies and the frozen version', () => {
    const pkg = JSON.parse(read(`${PLACEHOLDER_DIR}/package.json`));
    expect(pkg.version).toBe(PLACEHOLDER_VERSION);
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) expect(pkg[field], field).toBeUndefined();
  });
});

describe('the workflows do what the classification says', () => {
  it('release.yml packs the root package and publishes that tarball — nothing from packages/', () => {
    const release = read('.github/workflows/release.yml');
    const name = JSON.parse(read('package.json')).name as string;
    const tarball = `${name.replace(/^@/, '').replace('/', '-')}-*.tgz`;
    expect(release).toContain(`ls -1 ${tarball}`);
    expect(release).toMatch(/npm publish "\.\/\$TARBALL"/);
    expect(release).not.toMatch(/working-directory:\s*packages\//);
    expect(release).not.toMatch(/cd packages\//);
  });

  it('publish-python.yml builds and publishes the Python client from its directory', () => {
    const py = read('.github/workflows/publish-python.yml');
    expect(py).toContain(`python -m build ${PYPI_DIR}`);
    expect(py).toContain(`${PYPI_DIR}/pyproject.toml`);
    expect(py).toMatch(/pypa\/gh-action-pypi-publish@/);
  });

  it('no other workflow publishes a package to any registry', () => {
    const publishers = workflows.filter((f) => /npm publish|pypa\/gh-action-pypi-publish|twine upload|yarn npm publish|pnpm publish/.test(read(`.github/workflows/${f}`)));
    expect(publishers.sort()).toEqual(['publish-python.yml', 'release.yml']);
  });

  it('no workflow builds or tests a private package as if it shipped', () => {
    for (const p of packages.filter((x) => x.kind === 'private')) {
      for (const f of workflows) {
        expect(read(`.github/workflows/${f}`), `${f} runs ${p.dir}`).not.toMatch(new RegExp(`(cd|working-directory:)\\s*${p.dir.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\b`));
      }
    }
  });
});
