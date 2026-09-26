#!/usr/bin/env node
/*
 * verify — the bundle holds exactly this npm package.
 *
 * Reads an MCPB bundle and an npm tarball and fails unless every file of
 * the package is in the bundle byte for byte, and everything in the
 * bundle outside node_modules/ is either one of those files or the
 * bundle's own manifest.json and icon. The release runs it against the
 * tarball npm serves for the version just published, so "built from the
 * published package" is checked from outside, not asserted.
 *
 *   node scripts/mcpb/verify.mjs --bundle iris-eval.mcpb --tarball iris-eval-mcp-server-0.20.0.tgz
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTarball, readZip } from './archive.mjs';

/** The differences between a bundle's files and a package's, as sentences; empty when it holds exactly the package. */
export function compareBundleToPackage(bundle, pkg) {
  const problems = [];
  for (const [path, data] of pkg) {
    const inBundle = bundle.get(path);
    if (!inBundle) problems.push(`${path} is in the package but not in the bundle`);
    else if (!inBundle.equals(data)) problems.push(`${path} differs between the package and the bundle`);
  }
  const manifest = bundle.get('manifest.json');
  if (!manifest) return [...problems, 'the bundle has no manifest.json'];
  const own = new Set(['manifest.json', JSON.parse(manifest.toString('utf8')).icon]);
  for (const path of bundle.keys()) {
    if (path.startsWith('node_modules/') || own.has(path) || pkg.has(path)) continue;
    problems.push(`${path} is in the bundle but not in the package`);
  }
  return problems;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const bundlePath = flag('--bundle');
  const tarballPath = flag('--tarball');
  if (!bundlePath || !tarballPath) {
    console.error('usage: node scripts/mcpb/verify.mjs --bundle <file.mcpb> --tarball <file.tgz>');
    process.exit(2);
  }
  const pkg = readTarball(readFileSync(tarballPath));
  const problems = compareBundleToPackage(readZip(readFileSync(bundlePath)), pkg);
  if (problems.length > 0) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exit(1);
  }
  console.log(`✓ ${bundlePath} holds the ${pkg.size} files of ${tarballPath}, byte for byte`);
}
