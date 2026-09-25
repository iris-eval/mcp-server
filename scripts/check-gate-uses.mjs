#!/usr/bin/env node
/*
 * The gate action's tag in every `uses:` line a reader copies must name the
 * release being cut.
 *
 * README.md, docs/ci-gate.md and the action's own header show
 * `uses: iris-eval/mcp-server/.github/actions/gate@vX.Y.Z`. Nothing moved
 * those tags, so they sat at the release the action first shipped in while
 * the action (and the server it pins) moved on. scripts/sync-versions.mjs
 * rewrites them with the same pattern; this is the matching check, called
 * from scripts/check-version.sh. A file with no such line fails: a snippet
 * moved elsewhere must not turn the check into a no-op.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8')).version;
const GATE_USES_FILES = ['README.md', 'docs/ci-gate.md', '.github/actions/gate/action.yml'];
const pattern = /iris-eval\/mcp-server\/\.github\/actions\/gate@v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]*[0-9A-Za-z])?)/g;

let errors = 0;
for (const file of GATE_USES_FILES) {
  const path = resolve(root, file);
  if (!existsSync(path)) {
    console.log(`MISSING: ${file} (expected a gate action uses: line)`);
    errors += 1;
    continue;
  }
  const found = [...readFileSync(path, 'utf-8').matchAll(pattern)].map((m) => m[1]);
  const wrong = [...new Set(found.filter((v) => v !== version))];
  if (found.length === 0) {
    console.log(`MISSING: ${file} carries no gate action uses: line`);
    errors += 1;
  } else if (wrong.length > 0) {
    console.log(`MISMATCH: ${file} pins the gate action at @v${wrong.join(', @v')}, not @v${version} (run npm run version:sync)`);
    errors += 1;
  } else {
    console.log(`  OK: ${file} (gate action uses: @v${version}, ${found.length} line(s))`);
  }
}
process.exit(errors > 0 ? 1 : 0);
