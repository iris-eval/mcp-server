// MCP tools generator — walks src/tools/*.ts files, extracts the canonical
// tool name from each `server.registerTool('<name>', ...)` call, and counts
// annotations.

import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

// Matches `server.registerTool('<name>',` or `server.registerTool("<name>",`
/*
 * Global: matchAll below collects EVERY registration in a file. The
 * non-global form with String.match() returned only the first, so a file
 * registering two tools would undercount the truthbase — while
 * check-product-claims.sh, which counts call sites in index.ts, kept the
 * real number and turned CI red for a reason nobody would guess. It happens
 * to be correct today only because each of the ten files registers exactly
 * one tool; that is a layout coincidence, not an invariant.
 */
const REGISTER_TOOL_RE = /server\.registerTool\s*\(\s*['"]([a-z_][a-z0-9_]*)['"]/g;

export async function generate() {
  const toolsDir = resolve(root, 'src/tools');
  const files = (await readdir(toolsDir))
    .filter(f => f.endsWith('.ts') && f !== 'index.ts');

  const names = [];
  let readOnlyHintCount = 0;
  let destructiveHintCount = 0;
  let openWorldHintCount = 0;

  for (const f of files) {
    const src = await readFile(resolve(toolsDir, f), 'utf-8');
    for (const m of src.matchAll(REGISTER_TOOL_RE)) names.push(m[1]);
    if (/readOnlyHint:\s*true/.test(src)) readOnlyHintCount++;
    if (/destructiveHint:\s*true/.test(src)) destructiveHintCount++;
    if (/openWorldHint:\s*true/.test(src)) openWorldHintCount++;
  }

  names.sort();

  return {
    count: names.length,
    names,
    annotations: {
      readOnlyHintCount,
      destructiveHintCount,
      openWorldHintCount,
    },
  };
}
