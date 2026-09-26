#!/usr/bin/env node
/*
 * pack — build the MCPB bundle (iris-eval.mcpb) from the npm package.
 *
 * An MCPB bundle is a ZIP archive holding a local MCP server, everything it
 * needs to run, and a manifest.json that tells the host how to start it
 * (https://github.com/modelcontextprotocol/mcpb, MANIFEST.md). Claude
 * Desktop installs one by double-click; Smithery lists a local server
 * through one.
 *
 * The bundle is built from the published package, not from the working
 * tree: the input is the tarball `npm pack` produced (in the release, the
 * exact bytes npm publishes), so the server inside the bundle is the server
 * on npm. Around it go the manifest and icon from mcpb/, and the
 * production dependencies, resolved from package-lock.json and copied from
 * an installed node_modules whose versions must match the lockfile.
 *
 * better-sqlite3 is left out. It is a native addon compiled for one
 * platform and one Node ABI, and a bundle is one file for every platform:
 * built on Linux it would carry a Linux binary to a Mac. Claude Desktop runs
 * a Node bundle under its own built-in Node (Electron's) when the bundle's
 * declared Node range admits it, and that runtime has a different ABI from
 * any Node release. The manifest therefore starts the server with
 * IRIS_SQLITE_DRIVER=node — Node's built-in SQLite (src/storage/driver.ts),
 * which needs no addon — and declares the same Node range as package.json.
 * Nothing that remains needs an install script or a native binary, and this
 * script refuses to pack one that does.
 *
 * The output is deterministic (scripts/mcpb/archive.mjs): the same tarball,
 * lockfile and node_modules give the same bytes.
 *
 *   node scripts/mcpb/pack.mjs --tarball iris-eval-mcp-server-0.20.0.tgz --out iris-eval.mcpb
 *
 * Options (defaults relative to the repository root):
 *   --tarball <file>        the npm package to bundle (required)
 *   --out <file>            where to write the bundle (default: iris-eval.mcpb)
 *   --lockfile <file>       package-lock.json
 *   --node-modules <dir>    node_modules
 *   --manifest <file>       mcpb/manifest.json
 *   --icon <file>           mcpb/icon.png
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTarball, writeZip } from './archive.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The file name the release attaches and server.json points at. */
export const BUNDLE_NAME = 'iris-eval.mcpb';

/** Production dependencies the bundle leaves out, and why (see the header). */
export const EXCLUDED_DEPENDENCIES = { 'better-sqlite3': 'native addon; the bundle runs on node:sqlite' };

/** The files from the npm package the bundle must carry, or the server cannot start. */
export const REQUIRED_PACKAGE_FILES = ['package.json', 'dist/index.js', 'LICENSE', 'README.md'];

/**
 * The lockfile locations of every package the server needs at runtime,
 * minus `exclude` and whatever only they need: a walk from the root
 * package's dependencies through each package's dependencies,
 * optionalDependencies and required peerDependencies, resolved the way
 * Node resolves them (nearest node_modules first).
 */
export function productionClosure(lock, { exclude = Object.keys(EXCLUDED_DEPENDENCIES) } = {}) {
  const packages = lock.packages;
  if (!packages || !packages['']) throw new Error('lockfile: no packages[""] (lockfileVersion 2 or 3 is required)');
  const resolveFrom = (from, name) => {
    let base = from;
    for (;;) {
      const candidate = `${base ? `${base}/` : ''}node_modules/${name}`;
      if (packages[candidate]) return candidate;
      if (!base) return null;
      const i = base.lastIndexOf('/node_modules/');
      base = i < 0 ? '' : base.slice(0, i);
    }
  };
  const found = new Set();
  const queue = Object.keys(packages[''].dependencies ?? {})
    .filter((name) => !exclude.includes(name))
    .map((name) => ({ from: '', name, optional: false }));
  while (queue.length > 0) {
    const { from, name, optional } = queue.shift();
    const at = resolveFrom(from, name);
    if (!at) {
      if (optional) continue;
      throw new Error(`lockfile: ${name} (needed by ${from || 'the package'}) is not in package-lock.json`);
    }
    if (found.has(at)) continue;
    found.add(at);
    const entry = packages[at];
    for (const dep of Object.keys(entry.dependencies ?? {})) queue.push({ from: at, name: dep, optional: false });
    for (const dep of Object.keys(entry.optionalDependencies ?? {})) queue.push({ from: at, name: dep, optional: true });
    for (const dep of Object.keys(entry.peerDependencies ?? {})) {
      queue.push({ from: at, name: dep, optional: entry.peerDependenciesMeta?.[dep]?.optional === true });
    }
  }
  return [...found].sort();
}

function walk(dir, skipTopLevel, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipTopLevel.includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, [], out);
    else if (entry.isFile()) out.push(full);
    else throw new Error(`${full} is neither a file nor a directory (a symlink?); the bundle holds plain files only`);
  }
  return out;
}

const toZipPath = (p) => p.split(sep).join('/');

/**
 * Every file the bundle holds, as a Map of path → bytes. Pure: reads the
 * installed dependencies from `nodeModulesDir`, nothing else from disk.
 */
export function bundleFiles({ packageFiles, lock, nodeModulesDir, manifest, icon }) {
  for (const required of REQUIRED_PACKAGE_FILES) {
    if (!packageFiles.has(required)) throw new Error(`package: ${required} is missing from the tarball`);
  }
  const pkg = JSON.parse(packageFiles.get('package.json').toString('utf8'));
  if (manifest.version !== pkg.version) {
    throw new Error(`manifest: version ${manifest.version} is not the package's ${pkg.version} (run npm run version:sync)`);
  }
  const lockDeps = lock.packages[''].dependencies ?? {};
  if (JSON.stringify(lockDeps) !== JSON.stringify(pkg.dependencies ?? {})) {
    throw new Error('lockfile: its root dependencies are not the package.json dependencies in the tarball; use the lockfile from the same commit');
  }
  if (!packageFiles.has(manifest.server.entry_point)) {
    throw new Error(`manifest: entry point ${manifest.server.entry_point} is not in the package`);
  }

  const files = new Map();
  for (const [path, data] of packageFiles) files.set(path, data);
  files.set('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  files.set(manifest.icon, icon);

  const closure = productionClosure(lock);
  for (const at of closure) {
    const entry = lock.packages[at];
    const dir = join(nodeModulesDir, ...at.split('/').slice(1));
    const installedPath = join(dir, 'package.json');
    if (!existsSync(installedPath)) throw new Error(`node_modules: ${at} is not installed (run npm ci)`);
    const installed = JSON.parse(readFileSync(installedPath, 'utf8'));
    if (installed.version !== entry.version) {
      throw new Error(`node_modules: ${at} is ${installed.version}, package-lock.json says ${entry.version} (run npm ci)`);
    }
    if (entry.hasInstallScript) throw new Error(`${at} needs an install script to work; a bundle cannot run one`);
    for (const file of walk(dir, ['node_modules'])) {
      files.set(toZipPath(join(at, relative(dir, file))), readFileSync(file));
    }
  }
  const native = [...files.keys()].filter((p) => p.endsWith('.node'));
  if (native.length > 0) throw new Error(`the bundle would carry native binaries, which run on one platform only: ${native.join(', ')}`);
  return { files, packages: closure.length };
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function parseArgs(argv) {
  const options = {
    out: BUNDLE_NAME,
    lockfile: join(root, 'package-lock.json'),
    nodeModules: join(root, 'node_modules'),
    manifest: join(root, 'mcpb', 'manifest.json'),
    icon: join(root, 'mcpb', 'icon.png'),
  };
  const names = { '--tarball': 'tarball', '--out': 'out', '--lockfile': 'lockfile', '--node-modules': 'nodeModules', '--manifest': 'manifest', '--icon': 'icon' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = names[argv[i]];
    if (!key || argv[i + 1] === undefined) throw new Error(`unknown or incomplete option: ${argv[i]}`);
    options[key] = argv[i + 1];
  }
  if (!options.tarball) throw new Error('--tarball <file> is required');
  return options;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const { files, packages } = bundleFiles({
      packageFiles: readTarball(readFileSync(options.tarball)),
      lock: JSON.parse(readFileSync(options.lockfile, 'utf8')),
      nodeModulesDir: options.nodeModules,
      manifest: JSON.parse(readFileSync(options.manifest, 'utf8')),
      icon: readFileSync(options.icon),
    });
    const zip = writeZip(files);
    writeFileSync(options.out, zip);
    const unpacked = [...files.values()].reduce((n, b) => n + b.length, 0);
    console.log(`${options.out}: ${files.size} files (${packages} dependency packages), ${(unpacked / 1048576).toFixed(1)} MB unpacked, ${(statSync(options.out).size / 1048576).toFixed(1)} MB packed`);
    console.log(`sha256 ${sha256(zip)}`);
  } catch (err) {
    console.error(`mcpb pack: ${err.message}`);
    process.exit(1);
  }
}
