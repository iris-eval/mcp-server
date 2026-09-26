/*
 * Every package in the repository is exactly one thing.
 *
 * scripts/claims/packages.mjs walks every package.json and pyproject.toml
 * (not node_modules, and not website/, dashboard/ or examples/,
 * which ship nothing on a registry of their own) and classifies each from its
 * own manifest: the server release.yml publishes to npm, the Python client
 * publish-python.yml publishes to PyPI, a "private": true package, or the
 * `iris-eval` launcher. This suite fails on anything else, and
 * checks the workflows really do what the classification says — two in-repo
 * packages once had install commands on public surfaces, CI jobs building
 * them and publish workflows that could not publish, because nothing asked
 * which of these each one was.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-ignore — plain .mjs module
import { LAUNCHER_DIR, LAUNCHER_SERVER_RANGE, LAUNCHER_VERSION, PYPI_DIR, findManifests, inventory } from '../scripts/claims/packages.mjs';

const ROOT = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

type Entry = { manifest: string; dir: string; key: string; name: string | null; version: string | null; kind: string; published: boolean; reason?: string };
const packages = inventory() as Entry[];
const workflows = readdirSync(join(ROOT, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f));

describe('the package inventory', () => {
  it('classifies every manifest in the repository as release, pypi, private or launcher', () => {
    const unclassified = packages.filter((p) => p.kind === 'unclassified').map((p) => `${p.manifest}: ${p.reason}`);
    expect(unclassified).toEqual([]);
  });

  it('walks the tree it says it walks: the server, the Python client and the launcher are found, excluded directories are not', () => {
    const manifests = findManifests() as string[];
    expect(manifests).toContain('package.json');
    expect(manifests).toContain(`${PYPI_DIR}/pyproject.toml`);
    expect(manifests).toContain(`${LAUNCHER_DIR}/package.json`);
    for (const m of manifests) expect(m, m).not.toMatch(/^(website|dashboard|examples)\/|(^|\/)node_modules\//);
  });

  it('has exactly one package of each released kind', () => {
    expect(packages.filter((p) => p.kind === 'release').map((p) => p.dir)).toEqual(['.']);
    expect(packages.filter((p) => p.kind === 'pypi').map((p) => p.dir)).toEqual([PYPI_DIR]);
    expect(packages.filter((p) => p.kind === 'launcher').map((p) => p.dir)).toEqual([LAUNCHER_DIR]);
  });

  it('the launcher depends on the server alone, at the open-ended range, and has the frozen version', () => {
    const pkg = JSON.parse(read(`${LAUNCHER_DIR}/package.json`));
    expect(pkg.version).toBe(LAUNCHER_VERSION);
    expect(pkg.dependencies).toEqual({ [JSON.parse(read('package.json')).name]: LAUNCHER_SERVER_RANGE });
    for (const field of ['devDependencies', 'peerDependencies', 'optionalDependencies']) expect(pkg[field], field).toBeUndefined();
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

  /*
   * A private package may be built and tested in CI: that is how one earns
   * its first publish (the JavaScript SDK's wrappers are proven end to end
   * before anyone can install them). What CI must not do is present it as
   * shipped. So the job that runs it says, in its own text, that it is not
   * yet published, and nothing uploads its tarball anywhere. Publishing is
   * held by the test above: only release.yml and publish-python.yml publish.
   */
  it('a job that builds or tests a private package says it is not yet published, and ships nothing', () => {
    /** Each top-level job with the comment lines written above it: the text a reader of that job sees. */
    const jobsOf = (text: string): Array<{ id: string; text: string }> => {
      const lines = text.split('\n');
      const jobs: Array<{ id: string; lines: string[] }> = [];
      let pending: string[] = [];
      for (const line of lines.slice(lines.findIndex((l) => /^jobs:\s*$/.test(l)) + 1)) {
        const head = /^ {2}([\w-]+):\s*$/.exec(line);
        if (head) {
          jobs.push({ id: head[1], lines: [...pending, line] });
          pending = [];
        } else if (/^ {2}#/.test(line) || line.trim() === '') {
          pending.push(line);
        } else if (jobs.length > 0) {
          jobs[jobs.length - 1].lines.push(...pending, line);
          pending = [];
        }
      }
      return jobs.map((j) => ({ id: j.id, text: j.lines.join('\n') }));
    };
    for (const p of packages.filter((x) => x.kind === 'private')) {
      const runs = new RegExp(`(cd|working-directory:)\\s*${p.dir.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\b`);
      for (const f of workflows) {
        for (const job of jobsOf(read(`.github/workflows/${f}`)).filter((j) => runs.test(j.text))) {
          expect(job.text, `${f} job ${job.id} runs ${p.dir} without saying it is not yet published`).toMatch(/not yet published/i);
          expect(job.text, `${f} job ${job.id} uploads something while running ${p.dir}`).not.toMatch(/upload-artifact|npm publish/);
        }
      }
    }
  });
});
