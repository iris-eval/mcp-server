#!/usr/bin/env node
/*
 * check-bundle-size — CI gate for the dashboard's JavaScript and CSS.
 *
 * Since 0.20.0 (#662) each dashboard page is its own chunk, loaded when the
 * reader goes to it. The gate measures two things:
 *
 *   first load — the entry chunk, every chunk it imports statically, and
 *                their CSS: what must arrive before anything renders.
 *   each chunk — every other chunk (a page, or code pages share), against a
 *                budget of its own, so no page grows silently behind the
 *                first load.
 *
 * What belongs to the first load is read from Vite's build manifest
 * (dist/dashboard/.vite/manifest.json), not guessed from file names, so
 * stale files left in assets/ by earlier builds (`emptyOutDir: false`)
 * are never measured.
 *
 * Raising a budget means editing it here with the reason beside it — the
 * discipline that keeps size from drifting over a year.
 *
 * Runs after `npm run build` in the dashboard package.
 *
 * Usage:
 *   node scripts/check-bundle-size.mjs
 *   node scripts/check-bundle-size.mjs --json
 */

import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outDir = join(repoRoot, 'dist', 'dashboard');
const manifestPath = join(outDir, '.vite', 'manifest.json');

/*
 * Budgets in KB (1 KB = 1024 bytes), gzip being the number that bounds
 * transfer.
 *
 * History: a single bundle held every page until 0.20.0. Its last budget
 * was 600 KB raw / 168 KB gzip, against 564 / 163 measured on main before
 * the split (576,945 bytes / 166,296 gzipped).
 *
 * First load at the split: 302 KB raw / 95 KB gzip JS (the entry, the
 * React and Rolldown runtimes, and the data hooks the shell shares with
 * the pages), 26 KB / 6 KB CSS. The JS budget keeps ~15% headroom over
 * that. The CSS budget is unchanged: all CSS is still in the first load.
 */
const FIRST_LOAD_KB = {
  jsRaw: 350,
  jsGzip: 110,
  // cssRaw 20 -> 28 (#334): self-hosting the brand fonts adds ~4KB of
  // @font-face blocks — 15 unicode-range subsets across three families.
  // The raw number went up; what the user actually waits for went DOWN,
  // because the page no longer makes a blocking round-trip to
  // fonts.googleapis.com and then another to fonts.gstatic.com.
  cssRaw: 28,
  cssGzip: 8,
};

/*
 * Every chunk outside the first load, by the chunk's name. A chunk with no
 * entry here is held to DEFAULT_CHUNK_KB. A named budget that matches no
 * chunk fails the gate, so a renamed or removed page cannot leave a
 * budget nothing checks.
 *
 * At the split the largest chunk is d3, the charting code Health and
 * Drift share (44 KB raw / 16 KB gzip, named by the `d3` group in
 * dashboard/vite.config.ts); every other chunk is under 22 KB raw / 8 KB
 * gzip. The budgets keep ~15-20% headroom.
 */
const CHUNK_KB = {
  d3: { raw: 52, gzip: 19 },
};
const DEFAULT_CHUNK_KB = { raw: 28, gzip: 10 };

function fail(message) {
  console.error(`FATAL: ${message}`);
  process.exit(2);
}

if (!existsSync(manifestPath)) {
  fail(`build manifest not found: ${manifestPath}\nDid you run \`npm run build\` in the dashboard first? (vite.config.ts sets build.manifest.)`);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

/** Raw and gzip bytes of one built file. */
const sizeCache = new Map();
function measure(file) {
  if (!sizeCache.has(file)) {
    const content = readFileSync(join(outDir, file));
    sizeCache.set(file, { raw: content.length, gzip: gzipSync(content).length });
  }
  return sizeCache.get(file);
}
const kb = (bytes) => Math.ceil(bytes / 1024);

const entries = Object.entries(manifest).filter(([, c]) => c.isEntry);
if (entries.length !== 1) fail(`expected one entry chunk in the manifest, found ${entries.length}`);
const [entryKey] = entries[0];

/* The first load: the entry and its static imports, transitively. */
const firstLoad = new Set();
const stack = [entryKey];
while (stack.length > 0) {
  const key = stack.pop();
  if (firstLoad.has(key)) continue;
  if (!manifest[key]) fail(`manifest refers to ${key}, which it does not list`);
  firstLoad.add(key);
  for (const imported of manifest[key].imports ?? []) stack.push(imported);
}

function sum(keys, pick) {
  const files = new Set();
  for (const key of keys) for (const f of pick(manifest[key])) files.add(f);
  let raw = 0;
  let gzip = 0;
  for (const f of files) {
    const m = measure(f);
    raw += m.raw;
    gzip += m.gzip;
  }
  return { raw, gzip, files: [...files] };
}

const firstJs = sum(firstLoad, (c) => (c.file.endsWith('.js') ? [c.file] : []));
const firstCss = sum(firstLoad, (c) => [...(c.css ?? []), ...(c.file.endsWith('.css') ? [c.file] : [])]);

const failures = [];
const check = (label, bytes, budgetKb, kind) => {
  if (kb(bytes) > budgetKb) failures.push(`${label} ${kind} ${kb(bytes)} KB > budget ${budgetKb} KB`);
};
check('first-load JS', firstJs.raw, FIRST_LOAD_KB.jsRaw, 'raw');
check('first-load JS', firstJs.gzip, FIRST_LOAD_KB.jsGzip, 'gzip');
check('first-load CSS', firstCss.raw, FIRST_LOAD_KB.cssRaw, 'raw');
check('first-load CSS', firstCss.gzip, FIRST_LOAD_KB.cssGzip, 'gzip');

/* Every other chunk, each against its own budget. */
const chunks = [];
const seenNames = new Set();
for (const [key, c] of Object.entries(manifest)) {
  if (firstLoad.has(key) || !c.file.endsWith('.js')) continue;
  const name = c.name ?? key;
  seenNames.add(name);
  const css = (c.css ?? []).filter((f) => !firstCss.files.includes(f));
  const js = measure(c.file);
  let raw = js.raw;
  let gzip = js.gzip;
  for (const f of css) {
    raw += measure(f).raw;
    gzip += measure(f).gzip;
  }
  const budget = CHUNK_KB[name] ?? DEFAULT_CHUNK_KB;
  chunks.push({ name, file: c.file, source: c.src ?? null, rawKb: kb(raw), gzipKb: kb(gzip), rawBytes: raw, gzipBytes: gzip, budget });
  check(`chunk ${name}`, raw, budget.raw, 'raw');
  check(`chunk ${name}`, gzip, budget.gzip, 'gzip');
}
for (const name of Object.keys(CHUNK_KB)) {
  if (!seenNames.has(name)) failures.push(`budget for chunk "${name}" matches no chunk in this build: remove or rename it`);
}
chunks.sort((a, b) => b.gzipBytes - a.gzipBytes);

/*
 * Informational: what the landing page ("/", its default Failures view)
 * needs before it renders — the first load, the page, the view, and what
 * each imports.
 */
const landingKeys = ['DashboardPage', 'FailuresView'].map((n) => Object.keys(manifest).find((k) => manifest[k].name === n));
let landing = null;
if (landingKeys.every(Boolean)) {
  const keys = new Set(firstLoad);
  const s = [...landingKeys];
  while (s.length > 0) {
    const k = s.pop();
    if (keys.has(k)) continue;
    keys.add(k);
    for (const i of manifest[k].imports ?? []) s.push(i);
  }
  landing = sum(keys, (c) => (c.file.endsWith('.js') ? [c.file] : []));
}

const report = {
  firstLoad: {
    budgetKb: FIRST_LOAD_KB,
    js: { rawBytes: firstJs.raw, gzipBytes: firstJs.gzip, rawKb: kb(firstJs.raw), gzipKb: kb(firstJs.gzip), files: firstJs.files },
    css: { rawBytes: firstCss.raw, gzipBytes: firstCss.gzip, rawKb: kb(firstCss.raw), gzipKb: kb(firstCss.gzip), files: firstCss.files },
  },
  landingPageJs: landing ? { rawBytes: landing.raw, gzipBytes: landing.gzip, rawKb: kb(landing.raw), gzipKb: kb(landing.gzip) } : null,
  chunks,
  defaultChunkBudgetKb: DEFAULT_CHUNK_KB,
  failures,
  ok: failures.length === 0,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('Dashboard bundle size check:');
  console.log(`  First load JS:  ${kb(firstJs.raw)} KB raw / ${kb(firstJs.gzip)} KB gzip   (budget ${FIRST_LOAD_KB.jsRaw} / ${FIRST_LOAD_KB.jsGzip}; ${firstJs.files.length} file(s))`);
  console.log(`  First load CSS: ${kb(firstCss.raw)} KB raw / ${kb(firstCss.gzip)} KB gzip   (budget ${FIRST_LOAD_KB.cssRaw} / ${FIRST_LOAD_KB.cssGzip})`);
  if (landing) console.log(`  Landing page (/) JS, first load included: ${kb(landing.raw)} KB raw / ${kb(landing.gzip)} KB gzip (not gated)`);
  console.log(`  ${chunks.length} chunks loaded on demand; the largest:`);
  for (const c of chunks.slice(0, 8)) {
    console.log(`    ${c.name.padEnd(24)} ${String(c.rawKb).padStart(4)} KB raw / ${String(c.gzipKb).padStart(3)} KB gzip   (budget ${c.budget.raw} / ${c.budget.gzip})`);
  }
  if (failures.length > 0) {
    console.log('');
    console.log('FAIL — budget exceeded:');
    for (const f of failures) console.log(`  - ${f}`);
    console.log('');
    console.log('If this increase is intentional, edit the budget in scripts/check-bundle-size.mjs');
    console.log('with the reason beside it.');
  } else {
    console.log('');
    console.log('OK — first load and every chunk within budget.');
  }
}

process.exit(failures.length > 0 ? 1 : 0);
