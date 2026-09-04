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
  // The whole package dir, not just src/ — packages/langchain/README.md is
  // published to npm and led with the retired tagline for a full release
  // while the scanner walked only its source.
  'packages/langchain',
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
  /*
   * The pii/injection regexes cover BOTH orderings: "N PII patterns" and
   * "PII <up to 60 chars> N patterns" — the second catches "PII detection
   * across 10 patterns", "prompt injection (13 patterns)" and "13 attack
   * patterns", which all slipped past the count-first-only forms while the
   * gate reported OK (the gate-coverage-vs-claim failure: alive, but not
   * covering the set its name says it covers).
   *
   * Two more blind spots, both found on a CANONICAL live post (blog 005,
   * "10 regex patterns" / "13 regex patterns"), both now closed:
   *   - an INTERPOSED QUALIFIER between the number and the noun —
   *     `(?:\w+[\s-]+){0,2}` absorbs "regex", "distinct", "attack",
   *     "structural detector" and the like;
   *   - the rule-name spelling `no_pii` / `no_injection_patterns`, where
   *     the leading `_` is a word character so `\bPII` never matched. Both
   *     spellings are now anchors.
   */
  {
    name: 'pii-pattern-count',
    re: /\b(\d{1,3})\s+(?:\w+[\s-]+){0,2}PII\s+patterns\b|(?:\bPII\b|\bno_pii\b)[^.\n]{0,60}?\b(\d{1,3})\s+(?:\w+[\s-]+){0,2}patterns\b/gi,
    expected: c => [c.evalRules?.piiPatterns],
    fix: 'Import PII_PATTERN_COUNT from ~/lib/claims (or state the current count from .claims.json)',
  },
  {
    name: 'injection-pattern-count',
    re: /\b(\d{1,3})\s+(?:\w+[\s-]+){0,2}(?:prompt[- ])?injection\s+(?:attack\s+)?patterns\b|(?:\binjection\b|\bno_injection_patterns\b)[^.\n]{0,60}?\b(\d{1,3})\s+(?:\w+[\s-]+){0,2}(?:attack\s+)?patterns\b|\b(\d{1,3})\s+(?:\w+[\s-]+){0,2}attack\s+patterns\b/gi,
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
  /*
   * Product-name-plus-version prose: "Iris v0.4". The website's event
   * banner carried "Iris v0.4 - ..." through 0.4.6 and 0.5.0 beside a pill
   * that rendered the real version, and the pattern above only ever
   * matched a JSON-LD softwareVersion literal, so nothing lit up. CODE
   * flags always (render VERSION_MCP_SERVER); PROSE flags when the stated
   * version is not the shipped one, in either X.Y.Z or X.Y form. Dated
   * artifacts keep their period voice (same carve-out as
   * retired-positioning).
   */
  {
    name: 'product-version-prose',
    re: /\bIris\s+v?(\d+\.\d+(?:\.\d+)?)\b/g,
    expectedStrings: c => versionForms(c.version?.mcpServer),
    skipPrefixes: ['docs/blog/', 'docs/launch/'],
    fix: 'Render the version from the truthbase (VERSION_MCP_SERVER from ~/lib/claims; .claims.json version.mcpServer) instead of restating it.',
  },
  /*
   * Version captions inside the dashboard UI. The moment detail carried
   * "workflow inversion · v0.4" under its call to action and the sidebar
   * promised "Settings (coming v0.5)" two releases after 0.5 shipped —
   * a stranger reads both against the version in the footer and concludes
   * the product is stale. Any `v0.x` string in dashboard/src that is not
   * the shipping version is flagged; the footer renders its version from
   * the API, so nothing there needs a literal.
   */
  {
    name: 'dashboard-version-caption',
    re: /\bv(\d+\.\d+(?:\.\d+)?)\b/g,
    expectedStrings: c => versionForms(c.version?.mcpServer),
    onlyPrefixes: ['dashboard/src/'],
    skipComments: true, // historical notes in comments ('since v0.5.0') are not UI copy
    fix: 'Drop the version from the caption, or render it from the API/truthbase — never restate a release number in UI copy.',
  },
  /*
   * Published rate limits. The security page told readers the dashboard API
   * allowed 100 req/min while the shipped default had been 600 for a full
   * release — wrong by 6x on the one page a reader consults BECAUSE they
   * do not trust prose. There was no `security` key in the truthbase at
   * all, so neither claims gate could have caught it.
   *
   * `valueCheckedInCode` because the natural home for these numbers is a
   * sentence — nine MCP tool descriptions state "Rate-limited to 20
   * req/min on HTTP MCP" as part of the contract an agent reads. For those
   * the useful lock is "the number must be the shipped one", not "import a
   * constant"; the moment src/config/defaults.ts moves, every restatement
   * lights up.
   */
  {
    name: 'rate-limit',
    re: /\b(\d{1,5})\s*(?:requests?|req)\s*(?:\/|per\s+)\s*min(?:ute)?\b/gi,
    expected: c => [c.security?.rateLimit?.api, c.security?.rateLimit?.mcp],
    valueCheckedInCode: true,
    fix: 'State the shipped limit from .claims.json security.rateLimit (api=dashboard REST, mcp=MCP endpoint), or allow-list the site if it is a fixture / a different limiter',
  },
  /*
   * Retired positioning. 0.5.0 replaced "The Agent Eval Standard for MCP"
   * with the current tagline across ~19 surfaces, and the release notes
   * claimed every surface was drift-locked to brand.tagline — which was
   * prose: the exported TAGLINE constant had no consumers and no scanner
   * pattern existed. This is the lock. It is value-free: the retired
   * strings must not appear on a live surface at all.
   */
  {
    name: 'retired-positioning',
    re: /The Agent Eval Standard for MCP|the agent eval standard for MCP|MCP-Native Agent Eval (?:&|and) Observability/g,
    // Dated artifacts keep their period voice on purpose: published blog
    // posts carry editor's notes rather than being rewritten, and
    // docs/launch/* are frozen templates that each open with a historical
    // banner instructing a fresh compose before any reuse.
    skipPrefixes: ['docs/blog/', 'docs/launch/'],
    fix: 'Use the current tagline (.claims.json brand.tagline / TAGLINE from ~/lib/claims). If this is a dated artifact, it belongs under docs/blog/ or docs/launch/.',
  },
  /*
   * A measurement claim with nothing to point at. The roadmap and a live
   * blog post said the safety rules were "measured against a labeled
   * corpus", the LLM-judge docs called its score "calibrated", and no
   * public number existed for any of it — the measurement was private,
   * in-sample, at an older commit. This is value-free: the vocabulary of
   * measurement (measured against, labeled corpus, calibrated, precision,
   * recall, F1) may appear on a public surface only where the same line or
   * the line before it links to the measurement — the /proof page,
   * docs/proof.md or proof/results.json. Scope is the public prose
   * surfaces (README, docs/, website); dated artifacts keep their period
   * voice, the proof page IS the measurement, and code comments are
   * engineering notes rather than claims a stranger reads.
   */
  {
    name: 'measurement-claim-without-link',
    re: /\bmeasured against\b|\blabell?ed corpus\b|\bcalibrated\b|\bprecision\b|\brecall\b|\bF1\b/g,
    onlyPrefixes: ['README.md', 'docs/', 'website/src/', 'website/public/'],
    // website/src/lib/claims.ts is the truthbase reader: it TYPES the proof
    // schema (`precision: number`), which is an identifier, not a claim.
    skipPrefixes: ['docs/blog/', 'docs/launch/', 'docs/proof.md', 'website/src/app/proof/', 'website/src/lib/claims.ts'],
    skipComments: true,
    exemptIf: (text, index) => {
      const lineStart = text.lastIndexOf('\n', index - 1) + 1;
      const lineEnd = text.indexOf('\n', index);
      const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
      const prevStart = lineStart === 0 ? 0 : text.lastIndexOf('\n', lineStart - 2) + 1;
      const prev = lineStart === 0 ? '' : text.slice(prevStart, lineStart - 1);
      return MEASUREMENT_LINK_RE.test(line) || MEASUREMENT_LINK_RE.test(prev);
    },
    fix: 'Link the claim to the measurement on the same line or the line before (https://iris-eval.com/proof, docs/proof.md or proof/results.json) — or drop the measurement word if nothing was measured.',
  },
];

// What counts as "a link to the measurement": the proof page as a path or
// URL, the proof doc, or the results file. `\/proof\b` also matches
// `href="/proof"` and `https://iris-eval.com/proof`.
const MEASUREMENT_LINK_RE = /\/proof\b|docs\/proof\.md|proof\/results\.json/;

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);

// The truthful spellings of a shipped version in prose: "0.5.0" and "0.5".
function versionForms(v) {
  if (typeof v !== 'string') return [];
  const parts = v.split('.');
  return parts.length === 3 ? [v, parts.slice(0, 2).join('.')] : [v];
}

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
// The captured number is the first defined group: multi-alternative regexes
// (pii/injection) capture in different group positions per alternative.
//
// `valueCheckedInCode` opts a pattern out of the code-is-strict rule: some
// numbers live inside natural-language strings that ARE the product (MCP
// tool descriptions), where the useful lock is "the value must be right".
function matchFlags(pattern, m, relPath, claims) {
  const ext = relPath.slice(relPath.lastIndexOf('.'));
  const strictBecauseCode = CODE_EXTS.has(ext) && !pattern.valueCheckedInCode;
  // String-valued claims (versions) compare the captured text against the
  // truthful spellings; the numeric path below would read "0.5.0" as NaN.
  if (pattern.expectedStrings) {
    if (strictBecauseCode || !claims) return true;
    const captured = m.slice(1).find(g => g !== undefined);
    const truthful = pattern.expectedStrings(claims).filter(v => typeof v === 'string');
    return truthful.length === 0 || !truthful.includes(captured);
  }
  if (strictBecauseCode || !pattern.expected || !claims) return true;
  const captured = Number(m.slice(1).find(g => g !== undefined));
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

  /*
   * Coverage bookkeeping. A gate that only prints OK/FAIL cannot be audited:
   * "0 findings" reads identically whether a pattern walked 400 files or
   * matched nothing because its regex was structurally blind to the phrasing
   * actually used (feedback_gate_coverage_vs_claim — that is exactly how
   * "10 regex patterns" survived on a canonical live post). So the run now
   * reports, per pattern, how many sites it SAW, how many it cleared, how
   * many the allow-list excused and how many it skipped by prefix.
   */
  const coverage = new Map(
    PATTERNS.map(p => [p.name, { seen: 0, ok: 0, allowed: 0, skipped: 0, flagged: 0 }]),
  );
  let filesScanned = 0;

  const scanText = (rel, text) => {
    filesScanned++;
    for (const pattern of PATTERNS) {
      const cov = coverage.get(pattern.name);
      const skippedByPrefix = (pattern.skipPrefixes ?? []).some(p => rel.startsWith(p));
      const outsideOnly = pattern.onlyPrefixes ? !pattern.onlyPrefixes.some(p => rel.startsWith(p)) : false;
      pattern.re.lastIndex = 0;
      let m;
      while ((m = pattern.re.exec(text)) !== null) {
        cov.seen++;
        if (skippedByPrefix || outsideOnly) {
          cov.skipped++;
          continue;
        }
        if (!matchFlags(pattern, m, rel, claims)) {
          cov.ok++;
          continue;
        }
        // Pattern-specific clearance that needs the surrounding text (e.g.
        // "the same line or the previous line carries a link").
        if (pattern.exemptIf && pattern.exemptIf(text, m.index)) {
          cov.ok++;
          continue;
        }
        if (pattern.skipComments) {
          const lt = text.slice(text.lastIndexOf('\n', m.index) + 1, m.index).trimStart();
          if (lt.startsWith('//') || lt.startsWith('*') || lt.startsWith('/*')) {
            cov.ok++;
            continue;
          }
        }
        const line = lineNumber(text, m.index);
        const lineText = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index)).trim();
        const allowed = allowList.entries.some(
          e => e.file === rel && e.pattern === pattern.name && (e.line === line || e.line === '*'),
        );
        if (allowed) {
          cov.allowed++;
          continue;
        }
        cov.flagged++;
        findings.push({ file: rel, line, pattern: pattern.name, match: m[0], lineText, fix: pattern.fix });
      }
    }
  };

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
      scanText(rel, await readFile(path, 'utf-8'));
    }
  }

  // Specific top-level files
  for (const f of SCAN_FILES) {
    try {
      scanText(f, await readFile(resolve(root, f), 'utf-8'));
    } catch {
      /* file missing is fine */
    }
  }

  printCoverage(coverage, filesScanned, PATTERNS);

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

function printCoverage(coverage, filesScanned, patterns) {
  const tracksALiveNumber = new Map(patterns.map(p => [p.name, Boolean(p.expected)]));
  console.log(`[claims:check-no-hardcoded] coverage — ${filesScanned} files scanned`);
  for (const [name, c] of coverage) {
    const detail = [
      `${c.seen} site(s)`,
      `${c.ok} correct`,
      `${c.allowed} allow-listed`,
      `${c.skipped} dated-artifact`,
      `${c.flagged} flagged`,
    ].join(' · ');
    /*
     * A pattern that tracks a live number and matches NOTHING is the exact
     * failure this report exists to expose: the gate looks green while its
     * regex has gone structurally blind to the phrasing in use. Say it out
     * loud. Value-free GUARD patterns (retired taglines, forbidden
     * literals) are supposed to match nothing — silence there is success.
     */
    const note =
      c.seen === 0 && tracksALiveNumber.get(name)
        ? '   <- MATCHED NOTHING: verify the phrasing it targets still exists'
        : '';
    console.log(`  ${name.padEnd(26)} ${detail}${note}`);
  }
}

main().catch(err => {
  console.error('[claims:check-no-hardcoded] unexpected error:', err);
  process.exit(1);
});
