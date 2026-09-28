#!/usr/bin/env node
// The npm libraries and the launcher a release publishes beside the server,
// checked before anything is packed.
//
// release.yml's build-packages job runs this, then packs each directory in
// the order it prints, and publish-packages publishes the tarballs in that
// order. What it holds, for every package in NPM_PACKAGE_DIRS and the
// launcher (scripts/claims/packages.mjs):
//
//   - it can be published: not "private", and its publishConfig asks for
//     public access and provenance, so npm refuses a publish from anywhere
//     that cannot attest where it was built (a laptop, a CI without an
//     identity) instead of shipping one without provenance;
//   - it says where it lives: repository.directory is its directory, which
//     is what npm's provenance check compares with the workflow's source;
//   - the packages agree with each other: a package that depends on another
//     one published here (the LangChain.js handler's peer dependency on the
//     SDK) admits that package's current version, and comes after it in the
//     publish order, so a release never publishes a handler whose declared
//     SDK range excludes the SDK that ships beside it.
//
// Usage: node scripts/check-npm-packages.mjs            → problems, exit 1 on any
//        node scripts/check-npm-packages.mjs --order    → the directories, in publish order

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LAUNCHER_DIR, LAUNCHER_VERSION, NPM_PACKAGE_DIRS, ROOT } from './claims/packages.mjs';

/** Every directory release.yml publishes to npm besides the server, in publish order. */
export const PUBLISH_ORDER = [...NPM_PACKAGE_DIRS, LAUNCHER_DIR];

const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

function parse(version) {
  const m = VERSION.exec(version);
  return m ? m.slice(1, 4).map(Number) : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Whether `range` admits `version`. Only the forms these manifests use are
 * understood: an exact version, `^x.y.z` and `>=x.y.z`. Anything else is an
 * error rather than a guess, so a range this cannot read fails the check.
 */
export function admits(range, version) {
  const v = parse(version);
  if (!v) throw new Error(`"${version}" is not a plain x.y.z version`);
  const r = range.trim();
  if (parse(r)) return compare(v, parse(r)) === 0;
  if (r.startsWith('>=') && parse(r.slice(2))) return compare(v, parse(r.slice(2))) >= 0;
  if (r.startsWith('^') && parse(r.slice(1))) {
    const low = parse(r.slice(1));
    // ^1.2.3 := >=1.2.3 <2.0.0, ^0.2.3 := >=0.2.3 <0.3.0, ^0.0.3 := >=0.0.3 <0.0.4
    const high = low[0] > 0 ? [low[0] + 1, 0, 0] : low[1] > 0 ? [0, low[1] + 1, 0] : [0, 0, low[2] + 1];
    return compare(v, low) >= 0 && compare(v, high) < 0;
  }
  throw new Error(`range "${range}" is not one this check reads (x.y.z, ^x.y.z or >=x.y.z)`);
}

export function readManifests(root = ROOT) {
  return PUBLISH_ORDER.map((dir) => ({ dir, pkg: JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) }));
}

/** Every reason the packages cannot be published as they stand, as sentences. Empty when they can. */
export function packageProblems(manifests = readManifests()) {
  const problems = [];
  const position = new Map(manifests.map(({ pkg }, i) => [pkg.name, i]));
  for (const [i, { dir, pkg }] of manifests.entries()) {
    const at = `${dir}/package.json`;
    if (pkg.private === true) problems.push(`${at} is "private": true, so npm refuses to publish it`);
    if (!parse(pkg.version ?? '')) problems.push(`${at} version "${pkg.version}" is not a plain x.y.z version`);
    if (pkg.publishConfig?.access !== 'public') problems.push(`${at} publishConfig.access is not "public"`);
    if (pkg.publishConfig?.provenance !== true) problems.push(`${at} publishConfig.provenance is not true, so a publish without provenance would go through`);
    if (pkg.repository?.directory !== dir) problems.push(`${at} repository.directory is "${pkg.repository?.directory}", not "${dir}"`);
    if (dir === LAUNCHER_DIR && pkg.version !== LAUNCHER_VERSION) problems.push(`${at} version ${pkg.version} is not LAUNCHER_VERSION ${LAUNCHER_VERSION}`);
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, range] of Object.entries(pkg[field] ?? {})) {
        const j = position.get(name);
        if (j === undefined) continue;
        if (j > i) problems.push(`${at} ${field} names ${name}, which is published after it; ${name} must come first in the publish order`);
        const target = manifests[j].pkg.version;
        try {
          if (!admits(range, target)) problems.push(`${at} ${field} asks for ${name}@${range}, which does not admit the ${target} published beside it`);
        } catch (err) {
          problems.push(`${at} ${field} ${name}: ${err.message}`);
        }
      }
    }
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.includes('--order')) {
    process.stdout.write(PUBLISH_ORDER.join('\n') + '\n');
  } else {
    const manifests = readManifests();
    const problems = packageProblems(manifests);
    for (const { dir, pkg } of manifests) console.log(`  ${pkg.name}@${pkg.version}  (${dir})`);
    if (problems.length > 0) {
      for (const p of problems) console.error(`FAIL: ${p}`);
      process.exit(1);
    }
    console.log(`OK: ${manifests.length} packages can be published, in this order`);
  }
}
