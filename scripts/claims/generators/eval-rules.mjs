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

// The shipped default for `eval_type` when a caller omits it. Both skill files
// said "defaults to completeness, so safety rules do NOT run" for a full release
// after the engine moved to `all` — nothing in the truthbase carried the default,
// so no scanner pattern could disagree with the prose. Read it from the engine.
const ENGINE_FILE = 'src/eval/engine.ts';
const DEFAULT_EVAL_TYPE_RE = /export\s+const\s+DEFAULT_EVAL_TYPE\s*:\s*\w+\s*=\s*'(\w+)'/;

// The custom-rule types a caller can deploy or pass inline. Six compare pages
// said "4 custom-rule types" against a union of eight, and no scanner pattern
// tracked the count because the truthbase never carried it. Read the union
// itself, in declaration order.
const TYPES_FILE = 'src/types/eval.ts';
const CUSTOM_RULE_TYPE_RE = /export\s+type\s+CustomRuleType\s*=([\s\S]*?);/;

// The roster's declared metadata (0.9.0): kind · mechanism · needs · question ·
// classes · version per built-in, and the evaluation questions the rules
// declare against. Read from the rule objects and src/eval/questions.ts;
// tests/unit/eval/rule-metadata.test.ts anchors both to the runtime registry.
const QUESTIONS_FILE = 'src/eval/questions.ts';
const scalar = (block, key) => {
  const m = block.match(new RegExp(`^\\s*${key}:\\s*'([a-z_]+)',`, 'm'));
  return m ? m[1] : null;
};
const list = (block, key) => {
  const m = block.match(new RegExp(`^\\s*${key}:\\s*\\[([^\\]]*)\\],`, 'm'));
  return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : null;
};
function rosterFrom(sources) {
  const roster = [];
  for (const src of Object.values(sources)) {
    const re = /export\s+const\s+\w+\s*:\s*EvalRule\s*=\s*\{/g;
    let m;
    while ((m = re.exec(src))) {
      const start = m.index;
      const end = src.indexOf('\n};', start);
      const block = src.slice(start, end === -1 ? undefined : end);
      const name = scalar(block, 'name');
      const versionMatch = block.match(/^\s*version:\s*(\d+),/m);
      roster.push({
        name,
        kind: scalar(block, 'kind'),
        mechanism: scalar(block, 'mechanism'),
        needs: list(block, 'needs'),
        question: scalar(block, 'question'),
        classes: list(block, 'classes'),
        version: versionMatch ? Number(versionMatch[1]) : null,
      });
    }
  }
  return roster.sort((a, b) => a.name.localeCompare(b.name));
}
function questionsFrom(src) {
  return [...src.matchAll(/\{\s*id:\s*'([a-z_]+)',\s*text:\s*'((?:[^'\\]|\\.)*)',\s*answeredBy:\s*'(rule|tool|surface)'\s*\}/g)].map((m) => ({
    id: m[1],
    text: m[2].replace(/\\'/g, "'"),
    answeredBy: m[3],
  }));
}

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

  // Pattern arrays — search across all rule files. The capture is anchored
  // to the `= [` ASSIGNMENT bracket, not the first `[` after the name: a
  // type annotation like `Array<{ placeholders?: RegExp[] }>` contains its
  // own `[`, and capturing from there put the annotation's tail inside the
  // counted body (shipped as 12 where the runtime truth was 19).
  const piiPatterns = countArrayElements(sources, /(?:const|let|var)\s+PII_PATTERNS[^=]*=\s*\[([\s\S]*?)\];/);
  const injectionPatterns = countArrayElements(sources, /(?:const|let|var)\s+INJECTION_PATTERNS[^=]*=\s*\[([\s\S]*?)\];/);
  const hallucinationMarkers = countArrayElements(sources, /(?:const|let|var)\s+HALLUCINATION_MARKERS[^=]*=\s*\[([\s\S]*?)\];/);
  const stubMarkers = extractStubMarkers(sources);

  const engineSrc = await readFile(resolve(root, ENGINE_FILE), 'utf-8');
  const dm = engineSrc.match(DEFAULT_EVAL_TYPE_RE);
  if (!dm) throw new Error(`eval-rules generator: DEFAULT_EVAL_TYPE not found in ${ENGINE_FILE}`);
  const defaultEvalType = dm[1];

  const typesSrc = await readFile(resolve(root, TYPES_FILE), 'utf-8');
  const tm = typesSrc.match(CUSTOM_RULE_TYPE_RE);
  if (!tm) throw new Error(`eval-rules generator: CustomRuleType union not found in ${TYPES_FILE}`);
  const customRuleTypes = [...tm[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  if (customRuleTypes.length === 0) throw new Error(`eval-rules generator: CustomRuleType union in ${TYPES_FILE} has no members`);

  const roster = rosterFrom(sources);
  const missing = roster.filter((r) => !r.name || !r.kind || !r.mechanism || !r.needs || !r.question || !r.classes || r.version === null);
  if (missing.length > 0) throw new Error(`eval-rules generator: rule metadata missing on ${missing.map((r) => r.name ?? '?').join(', ')}`);
  const questions = questionsFrom(await readFile(resolve(root, QUESTIONS_FILE), 'utf-8'));
  if (questions.length === 0) throw new Error(`eval-rules generator: no questions found in ${QUESTIONS_FILE}`);

  return {
    builtInCount: names.length,
    categories: CATEGORIES,
    categoryCount: CATEGORIES.length,
    customRuleTypeCount: customRuleTypes.length,
    customRuleTypes,
    defaultEvalType,
    names,
    piiPatterns,
    injectionPatterns,
    hallucinationMarkers,
    stubMarkers,
    roster,
    questions,
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
  // Last meaningful CODE character — comments excluded. The regex-opener
  // heuristic below must not read comment text: a regex element directly
  // after `// …payloads.` saw `.` as the previous character, was parsed as
  // division + bare quotes, and every element after it merged into one.
  let lastCode = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const n = s[i + 1];
    if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (c === '*' && n === '/') { inBlockComment = false; i++; } continue; }
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (inSingle) { if (c === "'") { inSingle = false; lastCode = c; } continue; }
    if (inDouble) { if (c === '"') { inDouble = false; lastCode = c; } continue; }
    if (inTemplate) { if (c === '`') { inTemplate = false; lastCode = c; } continue; }
    if (inRegex) {
      if (c === '[') inRegexClass = true;
      else if (c === ']') inRegexClass = false;
      else if (c === '/' && !inRegexClass) { inRegex = false; lastCode = c; }
      continue;
    }
    if (c === '/' && n === '/') { inLineComment = true; i++; continue; }
    if (c === '/' && n === '*') { inBlockComment = true; i++; continue; }
    if (c === "'") { inSingle = true; segmentHasContent = true; lastCode = c; continue; }
    if (c === '"') { inDouble = true; segmentHasContent = true; lastCode = c; continue; }
    if (c === '`') { inTemplate = true; segmentHasContent = true; lastCode = c; continue; }
    if (c === '/') {
      // Regex literal opener — in code position a `/` here can only start a
      // regex (after `,` `[` `(` `=` `:` or at segment start).
      if (lastCode === ',' || lastCode === '[' || lastCode === '(' || lastCode === '=' || lastCode === ':' || lastCode === '') {
        inRegex = true;
        segmentHasContent = true;
        continue;
      }
    }
    if (c === '(' || c === '[' || c === '{') { depth++; segmentHasContent = true; lastCode = c; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; segmentHasContent = true; lastCode = c; continue; }
    if (c === ',' && depth === 0) {
      if (segmentHasContent) count++;
      segmentHasContent = false;
      lastCode = c;
      continue;
    }
    if (!/\s/.test(c)) { segmentHasContent = true; lastCode = c; }
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
