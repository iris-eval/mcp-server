// MCP tools generator — walks src/tools/*.ts files, extracts the canonical
// tool name from each `server.registerTool('<name>', ...)` call, and counts
// annotations.

import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

// Matches `server.registerTool('<name>',` or `server.registerTool("<name>",`
const REGISTER_TOOL_RE = /server\.registerTool\s*\(\s*['"]([a-z_][a-z0-9_]*)['"]/;

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
    const m = src.match(REGISTER_TOOL_RE);
    if (m) names.push(m[1]);
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
