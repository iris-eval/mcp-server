#!/usr/bin/env node
// Build the dashboard SPA that the server serves.
//
// The dashboard is its own npm project (dashboard/package.json, its own
// lockfile), so a fresh clone that installs only the root package has no
// vite to build it with. Directories that build Iris from a clone — Glama
// runs `pnpm install && pnpm run build` — failed at exactly that point from
// the change that put the dashboard in `build` until this script. When the
// dashboard's dependencies are missing it installs them from the lockfile
// (`npm ci`), then builds; when they are present it only builds.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dashboard = join(root, 'dashboard');

// On Windows npm is npm.cmd, which only a shell runs; the shell gets one
// command string (every argument here is a fixed literal), since passing an
// argument array with `shell` is deprecated (DEP0190).
function run(args) {
  const opts = { cwd: dashboard, stdio: 'inherit' };
  const r = process.platform === 'win32' ? spawnSync(`npm ${args.join(' ')}`, { ...opts, shell: true }) : spawnSync('npm', args, opts);
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!existsSync(join(dashboard, 'node_modules', 'vite', 'package.json'))) {
  console.log('[build:dashboard] dashboard dependencies are not installed; running npm ci in dashboard/');
  run(['ci', '--no-audit', '--no-fund']);
}
run(['run', 'build']);
