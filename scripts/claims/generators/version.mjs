// Version generator — reads package.json across workspaces.
//
// Output shape: { mcpServer, langchainPackage, websitePackage, dashboardPackage, initPackage, published }

/*
 * Registry status of the npm-facing packages. STATIC on purpose: the
 * generator must run offline and deterministically, so probing the registry
 * (`npm view`) at generate time is not allowed — this is a recorded
 * decision, not a measurement. As of 2026-09-03, `npm view @iris-eval/init`
 * and `npm view @iris-eval/langchain` both return 404: the packages live in
 * this repo, build and test in CI, and have never been published, yet a CI
 * comment called one "a PUBLISHED npm package" and both READMEs opened with
 * install commands that cannot resolve. Whether to publish or retire them is
 * the founder's call; until then no surface may present them as installable
 * (tests/unpublished-packages-not-cited.test.ts walks every public surface).
 * Flip a flag to true in the same PR as the first publish, or delete the
 * package if it is retired.
 */
const PUBLISHED = {
  mcpServer: true,
  initPackage: false,
  langchainPackage: false,
};

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  return {
    mcpServer: await readVersion(resolve(root, 'package.json')),
    langchainPackage: await readVersion(resolve(root, 'packages/langchain/package.json')),
    websitePackage: await readVersion(resolve(root, 'website/package.json')),
    dashboardPackage: await readVersion(resolve(root, 'dashboard/package.json')),
    initPackage: await readVersion(resolve(root, 'packages/init/package.json')),
    published: { ...PUBLISHED },
  };
}
