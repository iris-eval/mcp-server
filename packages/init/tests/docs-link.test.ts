/**
 * The docs link is one string, and it points at something that exists.
 *
 * `https://iris-eval.com/docs/clients` was restated in three places —
 * package.json `homepage`, the README, and the last line the CLI prints on
 * `--help` — and the page has never existed. A 404 was the final impression
 * the installer left, delivered at exactly the moment a user was stuck.
 *
 * A live HTTP check would make CI depend on the network. This does the part
 * that actually drifts: the three surfaces must agree on one constant, the
 * retired path must not come back, and the anchor must exist as a heading in
 * the README it points at.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLIENT_DOCS_URL } from '../src/cli.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');

const RETIRED = 'iris-eval.com/docs/clients';

function read(path: string): string {
  return readFileSync(path, 'utf-8');
}

describe('per-client docs link', () => {
  it('package.json homepage is the shared constant', () => {
    const pkg = JSON.parse(read(resolve(pkgRoot, 'package.json'))) as { homepage?: string };
    expect(pkg.homepage).toBe(CLIENT_DOCS_URL);
  });

  it('the package README links to the shared constant', () => {
    expect(read(resolve(pkgRoot, 'README.md'))).toContain(CLIENT_DOCS_URL);
  });

  it('no surface still points at the retired 404 path', () => {
    for (const rel of ['package.json', 'README.md', 'src/cli.ts']) {
      expect(read(resolve(pkgRoot, rel)), `${rel} still links the 404`).not.toContain(RETIRED);
    }
  });

  it('the anchor it points at is a real heading in the root README', () => {
    const anchor = CLIENT_DOCS_URL.split('#')[1];
    expect(anchor, 'link lost its anchor').toBeTruthy();
    const headings = read(resolve(repoRoot, 'README.md'))
      .split('\n')
      .filter((l) => l.startsWith('#'))
      .map((l) =>
        l
          .replace(/^#+\s*/, '')
          .toLowerCase()
          .replace(/[^\w\s-]/g, '')
          .trim()
          .replace(/\s+/g, '-'),
      );
    expect(headings).toContain(anchor);
  });
});
