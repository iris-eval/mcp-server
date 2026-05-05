// Version generator — reads package.json across workspaces.
//
// Output shape: { mcpServer, langchainPackage, websitePackage, dashboardPackage, initPackage }

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
  };
}
