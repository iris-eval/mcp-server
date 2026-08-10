#!/usr/bin/env node
// Hardcoded-claim scanner — scans source for literals that should come
// from the truthbase. Exits non-zero if any unguarded match is found.
//
// Allow-list: scripts/claims/allow-list.json — explicit exemptions for
// historical / generator / fixture sites with reasoning.
//
// Run via: npm run claims:check
//
// Two enforcement modes per match (2026-07-07 upgrade — the 12/14/18 pattern
// counts survived for months in surfaces this scanner never walked):
//   - CODE files (.ts/.tsx/.js/.jsx/.mjs): a match ALWAYS flags — code must
//     import the truthbase reader, not restate numbers.
//   - PROSE files (.md/.mdx/.txt/.json/.html): a match flags only when the
//     number disagrees with .claims.json — prose may state the truth, and
//     the moment the truth changes, every stale restatement lights up.

import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

const SCAN_DIRS = [
  'src',
  'website/src',
  'website/public',
  'dashboard/src',
  'docs',
  'packages/langchain/src',
  'packages/init',
  'claude-plugin',
  // The DOT-prefixed one, which is where the real manifests live —
  // plugin.json and marketplace.json, the public plugin description Claude
  // Code users read. 'claude-plugin' above is the skills payload directory;
  // one missing dot left both manifests unscanned, and marketplace.json
  // does hardcode a tool count.
  '.claude-plugin',
  'skills',
];
const SCAN_FILES = ['README.md', 'server.json'];
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  'storybook-static',
  '__snapshots__',
  '.audit',
  '.claims-cache',
]);

// Patterns to flag. Each has a name + regex + suggested fix message.
// `expected(claims)` returns the set of truthful values for the captured
// number — prose matches inside that set pass; everything else flags.
// Patterns without `expected` flag every match (value-free patterns).
const PATTERNS = [
  {
    name: 'test-count',
    re: /\b(\d{2,5})\s+tests?\b/g,
    expected: c => [
      c.tests?.vitestRoot?.total,
      c.tests?.vitestDashboard?.total,
      c.tests?.integration?.total,
      c.tests?.playwrightE2E?.total,
      c.tests?.totalCombined,
    ],
    fix: 'Import TEST_COUNT_VITEST_ROOT (or _DASHBOARD / _INTEGRATION / _TOTAL) from ~/lib/claims',
  },
  {
    name: 'mcp-tool-count',
    re: /\b(\d{1,2})\s+MCP\s+tools?\b/gi,
    expected: c => [c.mcpTools?.count],
    fix: 'Import MCP_TOOL_COUNT from ~/lib/claims',
  },
  {
    name: 'builtin-rule-count',
    re: /\b(\d{1,2})\s+(?:built-?in|heuristic)\s+(?:eval\s+|deterministic\s+)?rules\b/gi,
    expected: c => [c.evalRules?.builtInCount],
    fix: 'Import BUILT_IN_RULE_COUNT from ~/lib/claims (or state the current count from .claims.json)',
  },
  {
    name: 'pii-pattern-count',
    re: /\b(\d{1,2})\s+PII\s+patterns\b/gi,
    expected: c => [c.evalRules?.piiPatterns],
    fix: 'Import PII_PATTERN_COUNT from ~/lib/claims (or state the current count from .claims.json)',
  },
  {
    name: 'injection-pattern-count',
    re: /\b(\d{1,2})\s+(?:prompt[- ])?injection\s+patterns\b/gi,
    expected: c => [c.evalRules?.injectionPatterns],
    fix: 'Import INJECTION_PATTERN_COUNT from ~/lib/claims (or state the current count from .claims.json)',
  },
  {
    name: 'hallucination-marker-count',
    re: /\b(\d{1,2})\s+hallucination\s+markers\b/gi,
    expected: c => [c.evalRules?.hallucinationMarkers],
    fix: 'Import HALLUCINATION_MARKER_COUNT from ~/lib/claims (or state the current count from .claims.json)',
  },
  {
    name: 'iris-version-literal',
    re: /\bsoftwareVersion\s*[:=]\s*["']0\.\d+\.\d+["']/g,
    fix: 'Use VERSION_MCP_SERVER from ~/lib/claims (do not hardcode JSON-LD softwareVersion)',
  },
];

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);

const ALLOW_LIST_PATH = resolve(root, 'scripts/claims/allow-list.json');

async function loadAllowList() {
  try {
    const raw = await readFile(ALLOW_LIST_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { entries: [] };
  }
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (SKIP_DIR_NAMES.has(e.name)) continue;
      yield* walk(resolve(dir, e.name));
    } else if (e.isFile()) {
      yield resolve(dir, e.name);
    }
  }
}

const SCAN_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs',
  '.md', '.mdx',
  '.json',
  '.html',
  '.txt',
]);

// CODE files must import the truthbase reader — any match flags. PROSE files
// may restate the truth — a match flags only when the number is wrong.
function matchFlags(pattern, m, relPath, claims) {
  const ext = relPath.slice(relPath.lastIndexOf('.'));
  if (CODE_EXTS.has(ext) || !pattern.expected || !claims) return true;
  const captured = Number(m[1]);
  const truthful = pattern.expected(claims).filter(v => typeof v === 'number');
  return truthful.length === 0 || !truthful.includes(captured);
}

function fileShouldScan(path) {
  const ext = path.slice(path.lastIndexOf('.'));
  return SCAN_EXTS.has(ext);
}

function lineNumber(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

async function main() {
  const allowList = await loadAllowList();
  let claims = null;
  try {
    claims = JSON.parse(await readFile(resolve(root, '.claims.json'), 'utf-8'));
  } catch {
    console.warn('[claims:check-no-hardcoded] WARN — .claims.json unreadable; prose value-checks degrade to strict mode');
  }
  const findings = [];

  // Walk scan dirs
  for (const d of SCAN_DIRS) {
    const full = resolve(root, d);
    try {
      await stat(full);
    } catch {
      continue;
    }
    for await (const path of walk(full)) {
      if (!fileShouldScan(path)) continue;
      const rel = relative(root, path).split(sep).join('/');
      const text = await readFile(path, 'utf-8');
      for (const pattern of PATTERNS) {
        pattern.re.lastIndex = 0;
        let m;
        while ((m = pattern.re.exec(text)) !== null) {
          if (!matchFlags(pattern, m, rel, claims)) continue;
          const line = lineNumber(text, m.index);
          const lineText = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index)).trim();
          const allowed = allowList.entries.some(
            e => e.file === rel && e.pattern === pattern.name && (e.line === line || e.line === '*'),
          );
          if (!allowed) {
            findings.push({ file: rel, line, pattern: pattern.name, match: m[0], lineText, fix: pattern.fix });
          }
        }
      }
    }
  }

  // Specific top-level files
  for (const f of SCAN_FILES) {
    const path = resolve(root, f);
    try {
      const text = await readFile(path, 'utf-8');
      for (const pattern of PATTERNS) {
        pattern.re.lastIndex = 0;
        let m;
        while ((m = pattern.re.exec(text)) !== null) {
          if (!matchFlags(pattern, m, f, claims)) continue;
          const line = lineNumber(text, m.index);
          const lineText = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index)).trim();
          const allowed = allowList.entries.some(
            e => e.file === f && e.pattern === pattern.name && (e.line === line || e.line === '*'),
          );
          if (!allowed) {
            findings.push({ file: f, line, pattern: pattern.name, match: m[0], lineText, fix: pattern.fix });
          }
        }
      }
    } catch {
      /* file missing is fine */
    }
  }

  if (findings.length === 0) {
    console.log('[claims:check-no-hardcoded] OK — no unguarded hardcoded claims found');
    return;
  }

  console.error(`[claims:check-no-hardcoded] FAIL — ${findings.length} unguarded hardcoded claim(s):`);
  for (const f of findings) {
    console.error(`\n  ${f.file}:${f.line}  [${f.pattern}]  ${f.match}`);
    console.error(`    ${f.lineText}`);
    console.error(`    fix: ${f.fix}`);
  }
  console.error('\nIf this site is intentional, add an entry to scripts/claims/allow-list.json with reasoning.');
  process.exit(1);
}

main().catch(err => {
  console.error('[claims:check-no-hardcoded] unexpected error:', err);
  process.exit(1);
});
