// Eval rules generator — counts `export const X: EvalRule = {` across rule files
// + extracts pattern array sizes for the safety / relevance subcategories.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

const RULE_FILES = [
  'src/eval/rules/completeness.ts',
  'src/eval/rules/relevance.ts',
  'src/eval/rules/safety.ts',
  'src/eval/rules/cost.ts',
];

const CATEGORIES = ['completeness', 'relevance', 'safety', 'cost'];

const RULE_DEF_RE = /export\s+const\s+(\w+)\s*:\s*EvalRule\s*=\s*\{/g;

export async function generate() {
  const allNames = [];
  const sources = {};
  for (const rel of RULE_FILES) {
    const src = await readFile(resolve(root, rel), 'utf-8');
    sources[rel] = src;
    const matches = [...src.matchAll(RULE_DEF_RE)];
    for (const m of matches) allNames.push(m[1]);
  }
  const names = [...new Set(allNames)].sort();

  // Pattern arrays — search across all rule files.
  const piiPatterns = countArrayElements(sources, /(?:const|let|var)\s+PII_PATTERNS[\s\S]*?\[([\s\S]*?)\];/);
  const injectionPatterns = countArrayElements(sources, /(?:const|let|var)\s+INJECTION_PATTERNS[\s\S]*?\[([\s\S]*?)\];/);
  const hallucinationMarkers = countArrayElements(sources, /(?:const|let|var)\s+HALLUCINATION_MARKERS[\s\S]*?\[([\s\S]*?)\];/);
  const stubMarkers = extractStubMarkers(sources);

  return {
    builtInCount: names.length,
    categories: CATEGORIES,
    categoryCount: CATEGORIES.length,
    names,
    piiPatterns,
    injectionPatterns,
    hallucinationMarkers,
    stubMarkers,
  };
}

function countArrayElements(sources, re) {
  for (const src of Object.values(sources)) {
    const m = src.match(re);
    if (m) {
      return countTopLevelElements(m[1]);
    }
  }
  return null;
}

/**
 * Count the top-level elements of an array body.
 *
 * Counts SEGMENTS with content rather than commas, so trailing commas don't
 * add one; skips line and block comments entirely, so prose commas in
 * comments don't count (both bugs shipped 12/14/18 where source truth was
 * 10/13/17 — see tests/claims-eval-rules-counts.test.ts, which locks this
 * counter to the runtime arrays). Regex literals are opaque, including
 * character classes holding `/` or brackets.
 *
 * Exported for the drift test only.
 */
export function countTopLevelElements(s) {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inRegex = false;
  let inRegexClass = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escape = false;
  let count = 0;
  let segmentHasContent = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const n = s[i + 1];
    if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (c === '*' && n === '/') { inBlockComment = false; i++; } continue; }
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (inSingle) { if (c === "'") inSingle = false; continue; }
    if (inDouble) { if (c === '"') inDouble = false; continue; }
    if (inTemplate) { if (c === '`') inTemplate = false; continue; }
    if (inRegex) {
      if (c === '[') inRegexClass = true;
      else if (c === ']') inRegexClass = false;
      else if (c === '/' && !inRegexClass) inRegex = false;
      continue;
    }
    if (c === '/' && n === '/') { inLineComment = true; i++; continue; }
    if (c === '/' && n === '*') { inBlockComment = true; i++; continue; }
    if (c === "'") { inSingle = true; segmentHasContent = true; continue; }
    if (c === '"') { inDouble = true; segmentHasContent = true; continue; }
    if (c === '`') { inTemplate = true; segmentHasContent = true; continue; }
    if (c === '/') {
      // Regex literal opener — in code position a `/` here can only start a
      // regex (after `,` `[` `(` `=` `:` or at segment start).
      const prev = s.slice(0, i).trimEnd().slice(-1);
      if (prev === ',' || prev === '[' || prev === '(' || prev === '=' || prev === ':' || prev === '') {
        inRegex = true;
        segmentHasContent = true;
        continue;
      }
    }
    if (c === '(' || c === '[' || c === '{') { depth++; segmentHasContent = true; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; segmentHasContent = true; continue; }
    if (c === ',' && depth === 0) {
      if (segmentHasContent) count++;
      segmentHasContent = false;
      continue;
    }
    if (!/\s/.test(c)) segmentHasContent = true;
  }
  if (segmentHasContent) count++;
  return count;
}

function extractStubMarkers(sources) {
  // Find STUB_MARKERS array if defined; else return our standard set.
  for (const src of Object.values(sources)) {
    const m = src.match(/STUB_MARKERS[\s\S]*?\[([\s\S]*?)\]/);
    if (m) {
      const lits = [...m[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map(x => x[1]);
      return lits;
    }
  }
  return [];
}
