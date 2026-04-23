#!/usr/bin/env node
/*
 * check-bundle-size — CI gate for dashboard bundle size.
 *
 * Measures the built dashboard JS + CSS (raw and gzipped) and fails if
 * any exceeds the declared budget. The point is to catch silent bloat
 * — a new dependency or feature that pushes us from 137KB gzipped to
 * 300KB should NOT ship without an explicit budget bump and a reason.
 *
 * Budgets are set at ~15-20% headroom above the current baseline
 * measured at v0.4.0 ship. Growth beyond this threshold requires:
 *   (a) editing this file to raise the budget
 *   (b) a commit message explaining why the budget went up
 *
 * That discipline is what keeps bundle size from drifting over a year.
 *
 * Runs after `npm run build` in the dashboard package. Assumes the
 * built artifacts live at `<repo-root>/dist/dashboard/assets/`.
 *
 * Usage:
 *   node scripts/check-bundle-size.mjs
 *   node scripts/check-bundle-size.mjs --json   # for CI annotations
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const assetsDir = join(repoRoot, 'dist', 'dashboard', 'assets');

/*
 * Budgets (in KB). Raising any of these requires a deliberate commit
 * explaining why — that's the whole point of a budget gate.
 *
 * Baseline as of 2026-04-23 (v0.4.0 ship window):
 *   JS   482KB raw / 137KB gzipped
 *   CSS    7KB raw /   3KB gzipped
 *
 * Budgets allow ~15-20% headroom for normal additions. Anything
 * larger is a regression or a strategic feature that deserves its
 * own budget conversation.
 */
const BUDGETS_KB = {
  jsRaw: 600,
  jsGzip: 160,
  cssRaw: 20,
  cssGzip: 8,
};

/**
 * Find the content-hashed JS/CSS bundle file.
 *
 * Vite config uses `emptyOutDir: false` so stale bundles from prior
 * builds accumulate in `dist/dashboard/assets/`. We pick the MOST
 * RECENTLY MODIFIED file so the check reflects the current build, not
 * a months-old artifact. CI starts from a clean checkout so this is a
 * no-op there; locally it handles the dev-loop case.
 */
function findBundle(dir, extension) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    console.error(`FATAL: assets directory not found: ${dir}`);
    console.error('Did you run `npm run build` in the dashboard first?');
    process.exit(2);
  }
  const matches = entries.filter(
    (name) => name.startsWith('index-') && name.endsWith(extension),
  );
  if (matches.length === 0) {
    console.error(`FATAL: no ${extension} bundle matching 'index-*${extension}' in ${dir}`);
    process.exit(2);
  }
  // Sort by mtime descending; newest first.
  const byMtime = matches
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (matches.length > 1) {
    console.log(
      `note: ${matches.length} ${extension} bundles found in assets/; measuring newest (${byMtime[0].name})`,
    );
  }
  return join(dir, byMtime[0].name);
}

/** Measure raw + gzip size in KB (ceil'd). */
function measure(path) {
  const content = readFileSync(path);
  const raw = statSync(path).size;
  const gzip = gzipSync(content).length;
  return {
    rawBytes: raw,
    rawKb: Math.ceil(raw / 1024),
    gzipBytes: gzip,
    gzipKb: Math.ceil(gzip / 1024),
  };
}

const jsPath = findBundle(assetsDir, '.js');
const cssPath = findBundle(assetsDir, '.css');

const js = measure(jsPath);
const css = measure(cssPath);

const failures = [];

if (js.rawKb > BUDGETS_KB.jsRaw) {
  failures.push(`JS raw ${js.rawKb}KB > budget ${BUDGETS_KB.jsRaw}KB`);
}
if (js.gzipKb > BUDGETS_KB.jsGzip) {
  failures.push(`JS gzip ${js.gzipKb}KB > budget ${BUDGETS_KB.jsGzip}KB`);
}
if (css.rawKb > BUDGETS_KB.cssRaw) {
  failures.push(`CSS raw ${css.rawKb}KB > budget ${BUDGETS_KB.cssRaw}KB`);
}
if (css.gzipKb > BUDGETS_KB.cssGzip) {
  failures.push(`CSS gzip ${css.gzipKb}KB > budget ${BUDGETS_KB.cssGzip}KB`);
}

const jsonMode = process.argv.includes('--json');

if (jsonMode) {
  const out = {
    budgets: BUDGETS_KB,
    measurements: {
      jsRawKb: js.rawKb,
      jsGzipKb: js.gzipKb,
      cssRawKb: css.rawKb,
      cssGzipKb: css.gzipKb,
    },
    failures,
    ok: failures.length === 0,
  };
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log('Dashboard bundle size check:');
  console.log(`  JS:  ${js.rawKb} KB raw  / ${js.gzipKb} KB gzip   (budget: ${BUDGETS_KB.jsRaw} raw / ${BUDGETS_KB.jsGzip} gzip)`);
  console.log(`  CSS: ${css.rawKb} KB raw / ${css.gzipKb} KB gzip   (budget: ${BUDGETS_KB.cssRaw} raw / ${BUDGETS_KB.cssGzip} gzip)`);
  if (failures.length > 0) {
    console.log('');
    console.log('FAIL — budget exceeded:');
    for (const f of failures) console.log(`  - ${f}`);
    console.log('');
    console.log('If this increase is intentional, edit BUDGETS_KB in scripts/check-bundle-size.mjs');
    console.log('with a commit message explaining why the budget went up.');
  } else {
    console.log('');
    console.log('OK — all bundles within budget.');
  }
}

process.exit(failures.length > 0 ? 1 : 0);
