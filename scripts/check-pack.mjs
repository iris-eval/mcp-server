#!/usr/bin/env node
/*
 * prepack — refuse to pack a server with no UI (A6-9).
 *
 * `npm run build` used to be `tsc` alone; dist/dashboard existed only
 * because CI and the release workflow ran a separate dashboard build step
 * before `npm publish`. A local `npm pack` after `npm run build` therefore
 * shipped a tarball whose `--dashboard` served "Dashboard UI bundle not
 * found" — the artifact depended on CI remembering.
 *
 * Now `npm run build` builds the dashboard, then the server, and this
 * script runs as `prepack` (npm runs it before `npm pack` and `npm publish`)
 * and refuses when any of the files the package promises is missing. The
 * same list is what CI's integrity step asserts after a build.
 */
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Every file the package cannot ship without, relative to the package root. */
export const REQUIRED_ARTIFACTS = ['dist/index.js', 'dist/dashboard/server.js', 'dist/dashboard/index.html'];

/** The required artifacts that are missing under `root`. */
export function missingArtifacts(root) {
  return REQUIRED_ARTIFACTS.filter((p) => !existsSync(resolve(root, p)));
}

const here = dirname(fileURLToPath(import.meta.url));
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const root = resolve(here, '..');
  const missing = missingArtifacts(root);
  if (missing.length > 0) {
    console.error(
      `[prepack] refusing to pack: ${missing.join(', ')} missing under dist/. ` +
        'Run `npm run build` — it builds the dashboard, then the server — and pack again.',
    );
    process.exit(1);
  }
  // stderr, so `npm pack --dry-run --json` keeps a clean stdout for its JSON.
  console.error('[prepack] dist/ carries the server and the dashboard');
}
