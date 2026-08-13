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

/*
 * The ANNOTATIONS object literal only — never the whole file.
 *
 * These counters used to test the raw source, so ANY mention of a hint
 * anywhere in the file counted, comments included. evaluate-output.ts
 * annotates `openWorldHint: false` and explains it in a trailing comment —
 * "…LLM-as-judge has its own tool with openWorldHint:true" — and that
 * sentence made the truthbase ship `openWorldHintCount: 3` while
 * `tools/list` advertised 2. A gate that reads comments is not reading the
 * product. tests/claims-eval-rules-counts.test.ts now anchors all three
 * counts to what the tools actually register at runtime.
 */
const ANNOTATIONS_BLOCK_RE = /annotations:\s*\{([\s\S]*?)\}/;

/*
 * Strip `//` line comments and `/* … *\/` blocks from an annotations
 * literal. Safe here precisely because an annotations block holds nothing
 * but `key: boolean,` pairs — no strings, no regex literals, nothing a
 * naive stripper can corrupt.
 */
function stripComments(block) {
  return block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

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
    const block = src.match(ANNOTATIONS_BLOCK_RE);
    if (!block) continue;
    const annotations = stripComments(block[1]);
    if (/readOnlyHint:\s*true/.test(annotations)) readOnlyHintCount++;
    if (/destructiveHint:\s*true/.test(annotations)) destructiveHintCount++;
    if (/openWorldHint:\s*true/.test(annotations)) openWorldHintCount++;
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
