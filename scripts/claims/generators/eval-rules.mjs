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
      const inner = m[1];
      // Each top-level element is comma-separated. Split carefully so commas
      // inside string literals or regex bodies don't double-count.
      return countTopLevelCommas(inner) + (inner.trim().length > 0 ? 1 : 0);
    }
  }
  return null;
}

function countTopLevelCommas(s) {
  // Crude top-level comma counter — handles single-quoted, double-quoted,
  // and template-string literals. Enough for our pattern arrays which are
  // simple string lists.
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inRegex = false;
  let escape = false;
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (inSingle) { if (c === "'") inSingle = false; continue; }
    if (inDouble) { if (c === '"') inDouble = false; continue; }
    if (inTemplate) { if (c === '`') inTemplate = false; continue; }
    if (inRegex) { if (c === '/') inRegex = false; continue; }
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === '`') { inTemplate = true; continue; }
    if (c === '/' && (s[i+1] !== '/' && s[i+1] !== '*')) {
      // Heuristic: if it looks like a regex literal opener, enter regex mode.
      // Conservative — we only enter when surrounded by typical regex context.
      const prev = s.slice(0, i).trimEnd().slice(-1);
      if (prev === ',' || prev === '[' || prev === '(' || prev === '=' || prev === '') {
        inRegex = true;
        continue;
      }
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) count++;
  }
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
