#!/usr/bin/env node
/*
 * Iris UAT harness — one command, four suites, one report.
 *
 *   node run-uat.mjs                 # everything
 *   node run-uat.mjs --suite A,C     # a subset
 *
 * Contract:
 *   - The iris repo is READ-ONLY. The only thing this harness may cause
 *     to be written inside it is dist/ (via `npm run build`, and only
 *     when dist is missing).
 *   - Every spawned server gets its own scratch IRIS_HOME under .work/,
 *     which is wiped at the start of each run. The founder's real
 *     ~/.iris is content-hashed before and after; any change fails the
 *     run outright.
 *   - Exit code 0 = every check passed, 1 = at least one ✗.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CRITICAL_GUARDED_FILES,
  IRIS_CLAIMS,
  IRIS_ENTRY,
  IRIS_REPO,
  REPORT_PATH,
  WORK_DIR,
} from './lib/env.mjs';
import { createRecorder, renderReport } from './lib/report.mjs';
import { diffSnapshots, snapshotRealHome } from './lib/guard.mjs';
import { runSuiteA } from './suites/a-cli.mjs';
import { runSuiteB } from './suites/b-mcp.mjs';
import { runSuiteC } from './suites/c-http.mjs';
import { runSuiteD } from './suites/d-dashboard.mjs';

const SELF = fileURLToPath(import.meta.url);

function git(args, fallback = 'unknown') {
  try {
    return execFileSync('git', args, { cwd: IRIS_REPO, encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
}

/** Newest mtime under a directory tree (ms). 0 when the path is absent. */
function newestMtime(paths) {
  let newest = 0;
  const visit = (p) => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const entry of readdirSync(p)) visit(join(p, entry));
    } else if (st.mtimeMs > newest) {
      newest = st.mtimeMs;
    }
  };
  for (const p of paths) visit(p);
  return newest;
}

function mtimeOf(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/*
 * Artifact freshness.
 *
 * The whole suite runs against dist/ — the artifact that actually ships.
 * This harness is re-run after fix branches merge, so a dist/ left over
 * from before the merge would report on code that is no longer main and
 * every check would be a lie told confidently. Compare mtimes and
 * rebuild when stale. Both builds write ONLY into dist/ (tsc via
 * tsconfig.build.json, vite via outDir ../dist/dashboard with
 * emptyOutDir:false, so neither clobbers the other).
 */
function ensureFreshArtifacts(notes) {
  const r = (p) => join(IRIS_REPO, p);

  const serverSrc = newestMtime([r('src'), r('package.json'), r('tsconfig.build.json')]);
  if (!existsSync(IRIS_ENTRY) || mtimeOf(IRIS_ENTRY) < serverSrc) {
    const why = existsSync(IRIS_ENTRY) ? 'older than src/' : 'missing';
    process.stdout.write(`  dist/ server bundle ${why} — running \`npm run build\`\n`);
    execFileSync('npm', ['run', 'build'], { cwd: IRIS_REPO, stdio: 'inherit', shell: true });
    notes.push(`Rebuilt the server bundle: \`npm run build\` (dist/ was ${why}).`);
  }

  const uiIndex = r('dist/dashboard/index.html');
  const uiSrc = newestMtime([
    r('dashboard/src'),
    r('dashboard/index.html'),
    r('dashboard/vite.config.ts'),
    r('dashboard/package.json'),
    r('package.json'),
    r('.claims.json'),
  ]);
  if (!existsSync(uiIndex) || mtimeOf(uiIndex) < uiSrc) {
    const why = existsSync(uiIndex) ? 'older than dashboard/src/' : 'missing';
    process.stdout.write(`  dashboard UI bundle ${why} — running \`npm run build\` in dashboard/\n`);
    execFileSync('npm', ['run', 'build'], { cwd: join(IRIS_REPO, 'dashboard'), stdio: 'inherit', shell: true });
    notes.push(`Rebuilt the dashboard UI bundle: \`cd dashboard && npm run build\` (dist/dashboard was ${why}).`);
  }

  return {
    serverFresh: mtimeOf(IRIS_ENTRY) >= serverSrc,
    uiFresh: mtimeOf(uiIndex) >= uiSrc,
  };
}

function parseSuites() {
  const idx = process.argv.indexOf('--suite');
  if (idx === -1) return ['A', 'B', 'C', 'D'];
  const raw = process.argv[idx + 1] ?? '';
  const wanted = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return wanted.length > 0 ? wanted : ['A', 'B', 'C', 'D'];
}

async function main() {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const suites = parseSuites();

  process.stdout.write('Iris UAT harness\n');
  process.stdout.write(`  repo    ${IRIS_REPO}\n`);
  process.stdout.write(`  suites  ${suites.join(', ')}\n`);

  // dist/ is the artifact under test, and the ONE thing this harness may
  // cause to be written inside the repo.
  const buildNotes = [];
  const freshness = ensureFreshArtifacts(buildNotes);

  const claims = JSON.parse(readFileSync(IRIS_CLAIMS, 'utf8'));

  // Idempotence: every run starts from an empty scratch tree.
  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });

  const before = snapshotRealHome();
  const commitAtStart = git(['rev-parse', '--short', 'HEAD']);
  const t = createRecorder();

  const runners = { A: runSuiteA, B: (r) => runSuiteB(r, claims), C: runSuiteC, D: runSuiteD };
  for (const id of suites) {
    const run = runners[id];
    if (!run) {
      process.stdout.write(`  (no such suite: ${id})\n`);
      continue;
    }
    try {
      await run(t);
    } catch (err) {
      t.fail(`${id}00`, `suite ${id} ran to completion`, `unhandled error: ${err && err.stack ? err.stack.split('\n')[0] : err}`);
    }
  }

  // ---- Artifact freshness + real-home integrity ------------------------
  t.beginSuite('G', 'Harness isolation + artifact freshness');

  await t.check('G0', 'the suite ran against a dist/ that is not older than the sources', () => {
    if (!freshness.serverFresh) throw new Error('dist/index.js is still older than src/ after the build step');
    if (!freshness.uiFresh) throw new Error('dist/dashboard/index.html is still older than dashboard/src/ after the build step');
    return buildNotes.length > 0 ? `rebuilt: ${buildNotes.length} bundle(s)` : 'both bundles already current';
  });

  const after = snapshotRealHome();
  const { changed, detail } = diffSnapshots(before, after);
  const criticalChanged = changed.filter((f) => CRITICAL_GUARDED_FILES.includes(f));

  await t.check('G1', 'the real ~/.iris/iris.db, custom-rules.json and audit.log are byte-identical after the run', () => {
    if (criticalChanged.length > 0) {
      throw new Error(`the harness modified real user data: ${criticalChanged.join(', ')}`);
    }
    return 'all three unchanged';
  });

  await t.check('G2', 'no other file in the real ~/.iris changed either', () => {
    const others = changed.filter((f) => !CRITICAL_GUARDED_FILES.includes(f));
    if (others.length > 0) throw new Error(`changed: ${others.join(', ')}`);
    return 'no incidental writes';
  });

  const counts = t.counts();
  const guardVerdict =
    changed.length === 0 ? 'CLEAN — no guarded file changed' : `**VIOLATED** — changed: ${changed.join(', ')}`;

  const commitAtEnd = git(['rev-parse', '--short', 'HEAD']);
  const meta = {
    startedAt,
    durationMs: Date.now() - t0,
    repo: IRIS_REPO,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    commit: commitAtEnd === commitAtStart ? commitAtEnd : `${commitAtStart} → ${commitAtEnd} (HEAD MOVED MID-RUN)`,
    buildNotes,
    dirty: git(['status', '--porcelain']).length > 0,
    dirtyCount: git(['status', '--porcelain']).split('\n').filter(Boolean).length,
    pkgVersion: JSON.parse(readFileSync(`${IRIS_REPO}/package.json`, 'utf8')).version,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    guardVerdict,
    guardDetail: detail,
    runCommandPath: SELF,
  };

  writeFileSync(REPORT_PATH, renderReport(t, meta), 'utf8');

  process.stdout.write('\n');
  process.stdout.write(`RESULT: ${counts.fail === 0 ? 'PASS' : 'FAIL'} — ${counts.pass} passed / ${counts.fail} failed / ${counts.total} checks\n`);
  for (const [id, c] of counts.bySuite) {
    process.stdout.write(`  suite ${id}: ${c.pass} pass / ${c.fail} fail\n`);
  }
  process.stdout.write(`report: ${REPORT_PATH}\n`);

  process.exit(counts.fail === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`UAT harness crashed: ${err && err.stack ? err.stack : err}\n`);
  process.exit(2);
});
