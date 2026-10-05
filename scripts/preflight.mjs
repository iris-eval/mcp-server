#!/usr/bin/env node
/*
 * npm run preflight — the checks a branch fails CI on, before you push.
 *
 * By default it runs the fast ones, in a few minutes: the claims and render
 * checks, lint, the type checks, the dashboard's and the website's checks
 * when the branch touches them, and the test files the branch adds or
 * changes. CI then runs everything, in parallel, in about eleven minutes.
 *
 * Not the whole suite, and not every test a change reaches: on a Windows
 * desktop the suite takes 12 minutes (most of it starting git and node
 * processes), and a change to a module every test imports reaches all of
 * it. A test elsewhere that a change breaks is what CI is for; the fast
 * checks are the ones that failed branches for no reason but a missed step.
 *
 * `--full` runs every check CI runs that can run here, one after another:
 * the whole suite with coverage, the builds, the proofs. On a desktop that is
 * 25 minutes and more, which is why it is not the default: run it when a
 * change is wide enough that you want CI's answer before CI gives it.
 *
 *   npm run preflight             the fast checks; on success, record the tree it verified
 *   npm run preflight -- --full   every check that can run here
 *   npm run preflight -- --list   the steps, and the CI jobs that only CI runs, with why
 *
 * It verifies a commit, not a working tree: it refuses to start with
 * uncommitted changes, and fails if a step changes a tracked file. On
 * success it writes `preflight-ok` in this checkout's git directory with the
 * tree it verified. A pre-push hook can refuse a branch whose tree is not
 * that one (scripts/git-hooks/pre-push does).
 *
 * Every job of every workflow that runs on a pull request is either a step
 * here or in CI_ONLY with the reason; tests/preflight-mirrors-ci.test.ts fails
 * when a job is neither.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
/** Where the root suite's JSON report goes; replaced with a fresh temporary path when it runs. */
const ROOT_REPORT = '{root-report}';
/** The root-suite test files the branch adds or changes; replaced when a step runs. */
const TEST_FILES = '{test-files}';
const ACTIONLINT = 'rhysd/actionlint@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667';

/** Checks the pack list carries the dashboard, as the build job does with jq. */
function packCarriesDashboard() {
  const r = spawnSync('npm pack --dry-run --json', { cwd: root, shell: true, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return { ok: false, why: 'npm pack --dry-run failed' };
  const files = JSON.parse(r.stdout)[0]?.files ?? [];
  return files.some((f) => f.path === 'dist/dashboard/index.html') ? { ok: true } : { ok: false, why: 'dist/dashboard/index.html is not in the pack list' };
}

/** The build job's last step: the files an install needs, and a server that starts. */
function packageIntegrity() {
  for (const f of ['dist/dashboard/server.js', 'dist/dashboard/index.html', 'dist/index.js']) if (!existsSync(join(root, f))) return { ok: false, why: `${f} missing after build` };
  const r = spawnSync(process.execPath, ['dist/index.js', '--help'], { cwd: root, encoding: 'utf-8' });
  return r.status === 0 ? { ok: true } : { ok: false, why: 'node dist/index.js --help failed' };
}

/**
 * The steps, cheapest first. `ci` names the job each one stands for, as
 * `<workflow file>#<job id>`. A step is a shell command run from `cwd`, or a
 * function returning { ok, why }.
 */
export const STEPS = [
  { name: 'versions agree', ci: ['ci.yml#lint-and-typecheck'], run: 'bash scripts/check-version.sh' },
  { name: 'product claims', ci: ['ci.yml#lint-and-typecheck'], run: 'bash scripts/check-product-claims.sh' },
  { name: 'no hardcoded claims', fast: true, ci: ['claims-alignment.yml#check-no-hardcoded'], run: 'node scripts/claims/check-no-hardcoded.mjs' },
  { name: 'llms.txt matches its templates', fast: true, ci: ['ci.yml#lint-and-typecheck', 'claims-alignment.yml#check-truthbase-regen'], run: 'npm run -s llms:check' },
  { name: 'the release narrative matches CHANGELOG.md', fast: true, ci: ['claims-alignment.yml#check-truthbase-regen'], run: 'npm run -s changelog:check' },
  { name: 'lint', fast: true, ci: ['ci.yml#lint-and-typecheck'], run: 'npm run -s lint' },
  { name: 'typecheck', fast: true, ci: ['ci.yml#lint-and-typecheck'], run: 'npm run -s typecheck' },
  { name: 'typecheck the tests', fast: true, ci: ['ci.yml#typecheck-tests'], run: 'npm run -s typecheck:tests' },
  { name: 'typecheck the proof runner', ci: ['ci.yml#proof'], run: 'npm run -s proof:typecheck' },
  { name: 'CUSUM thresholds', ci: ['ci.yml#cusum-thresholds'], run: 'npm run -s cusum:check' },
  { name: 'search tokenizer table', ci: ['ci.yml#search-tokenizer-table'], run: 'npm run -s unicode61:check' },
  { name: 'security exposure coverage', ci: ['ci.yml#security-exposure'], run: 'node scripts/security/check-exposure-coverage.mjs' },
  { name: 'workflows lint (actionlint, in Docker)', ci: ['ci.yml#actionlint'], run: `docker run --rm -v "${root.replace(/\\/g, '/')}:/repo" -w /repo ${ACTIONLINT} -color` },
  { name: 'dashboard typecheck and lint', fast: 'dashboard/', ci: ['ci.yml#lint-and-typecheck'], cwd: 'dashboard', run: 'npm run -s typecheck && npm run -s lint' },
  { name: 'dashboard tests', fast: 'dashboard/', ci: ['ci.yml#lint-and-typecheck'], cwd: 'dashboard', run: 'npm test --silent' },
  { name: 'dashboard Storybook build', ci: ['ci.yml#lint-and-typecheck'], cwd: 'dashboard', run: 'npm run -s build-storybook' },
  { name: 'website lint and types', fast: 'website/', fastOnly: true, ci: ['ci.yml#website-lint-and-typecheck'], cwd: 'website', run: 'npm run -s lint && npx tsc --noEmit' },
  { name: 'website lint, types and build', ci: ['ci.yml#website-lint-and-typecheck'], cwd: 'website', run: 'npm run -s lint && npx tsc --noEmit && npm run -s build' },
  { name: 'build', ci: ['ci.yml#build'], run: 'npm run -s build' },
  { name: 'the pack carries the dashboard', ci: ['ci.yml#build'], check: packCarriesDashboard },
  { name: 'exports', ci: ['ci.yml#build'], run: 'node scripts/check-exports.mjs' },
  { name: 'bundle size', ci: ['ci.yml#build'], run: 'node scripts/check-bundle-size.mjs' },
  { name: 'package integrity', ci: ['ci.yml#build'], check: packageIntegrity },
  { name: '.well-known/mcp.json matches the built server', ci: ['claims-alignment.yml#check-truthbase-regen'], run: 'npm run -s mcp-json:check' },
  { name: 'proof: rule accuracy', ci: ['ci.yml#proof'], run: 'npm run -s proof -- --check' },
  { name: 'proof: the composite corpus', ci: ['ci.yml#proof'], run: 'npm run -s proof -- --check --composite' },
  { name: 'proof: the real transcripts', ci: ['ci.yml#proof'], run: 'npm run -s proof -- --check --transcripts' },
  { name: 'proof: evidence left out, a failure added', ci: ['ci.yml#proof'], run: 'npm run -s proof -- --check --invariants' },
  { name: 'proof: runs Iris did not write', ci: ['ci.yml#proof'], run: 'npm run -s proof -- --check --outside' },
  { name: 'stall guard (native driver)', ci: ['ci.yml#stall-guard'], run: 'npx vitest run --config tests/stall/vitest.config.ts' },
  {
    name: 'every test, with the coverage floors',
    ci: ['ci.yml#test', 'ci.yml#integration', 'ci.yml#search-index'],
    run: `npx vitest run --coverage --reporter=dot --reporter=json --outputFile.json="${ROOT_REPORT}"`,
  },
  { name: 'truthbase regenerated matches the committed one', fast: true, ci: ['claims-alignment.yml#check-truthbase-regen'], run: 'node scripts/claims/generate.mjs --check' },
  {
    name: 'the test files this branch adds or changes',
    fast: true,
    fastOnly: true,
    ci: ['ci.yml#test'],
    run: `npx vitest run ${TEST_FILES} --reporter=dot --passWithNoTests`,
  },
];

/**
 * Jobs that run on a pull request and not here, with why. The test holds
 * this list and the workflows together.
 */
export const CI_ONLY = {
  'ci.yml#native-from-source': 'compiles better-sqlite3 from source on each OS; it needs a clean npm cache and a compiler',
  'ci.yml#upgrade': 'downloads the previous release from npm and upgrades its store',
  'ci.yml#real-clients-pack': 'packs a throwaway version for the real-client jobs',
  'ci.yml#no-native-sqlite': 'installs the packed server into an empty project without better-sqlite3',
  'ci.yml#real-clients': 'installs Claude Code, Gemini CLI and the other MCP clients and drives them',
  'ci.yml#mcpb-pack': 'packs the MCPB bundle for the bundle jobs',
  'ci.yml#mcpb': 'unpacks and validates the MCPB bundle on each OS',
  'ci.yml#mcpb-electron': "runs the bundle inside Electron's Node",
  'ci.yml#docker-build': 'builds the container image and runs it',
  'ci.yml#fresh-clone-build': 'a fresh clone built with pnpm',
  'ci.yml#e2e': 'Playwright drives the dashboard in Chromium and Firefox',
  'ci.yml#gate-action': 'runs the gate action itself on a seeded dataset',
  'ci.yml#python-client': 'the Python client against a running server, on each Python',
  'ci.yml#sdk-js': 'the JavaScript SDK, its own install, build and tests, and a packed consumer',
  'ci.yml#langchain-js': 'the LangChain.js handler, its own install, build and tests, and a packed consumer',
  'ci.yml#otel-recipes': 'the OpenTelemetry recipes against a running server, in Python and JavaScript',
  'claims-alignment.yml#required-checks': "reads branch protection, which needs the repository's API",
  'codeql.yml#analyze': "GitHub's CodeQL analysis",
  'lighthouse.yml#lighthouse': 'Lighthouse against a built site in a browser',
  'worker-exit.yml#worker-exit': 'worker threads started and ended thousands of times per OS and Node; 20 to 60 minutes a cell',
  'publish-python.yml#build': 'builds the Python sdist and wheel',
  'publish-python.yml#publish': 'publishes to PyPI on a tag; skipped on a pull request',
};

function git(args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf-8' }).stdout.trim();
}

/** Where the branch left main: the merge base with origin/main, else the parent commit. */
function baseOf() {
  return git(['merge-base', 'HEAD', 'origin/main']) || git(['rev-parse', 'HEAD~1']);
}

/** The steps a mode runs. Fast: the marked ones, and a folder's only when the branch touched it. */
export function stepsFor(full, changed) {
  if (full) return STEPS.filter((s) => !s.fastOnly);
  return STEPS.filter((s) => s.fast === true || (typeof s.fast === 'string' && changed.some((f) => f.startsWith(s.fast))));
}

function main(scratch) {
  const rootReport = join(scratch, 'root-tests.json');
  const full = process.argv.includes('--full');
  if (process.argv.includes('--list')) {
    process.stdout.write('Fast (the default):\n');
    for (const s of STEPS.filter((x) => x.fast)) process.stdout.write(`  ${s.name}${typeof s.fast === 'string' ? ` (when ${s.fast} changed)` : ''}\n`);
    process.stdout.write('\n--full:\n');
    for (const s of stepsFor(true, [])) process.stdout.write(`  ${s.name}  (${s.ci.join(', ')})\n`);
    process.stdout.write('\nCI only:\n');
    for (const [job, why] of Object.entries(CI_ONLY)) process.stdout.write(`  ${job}: ${why}\n`);
    return 0;
  }
  if (git(['status', '--porcelain'])) {
    process.stderr.write('preflight — the working tree has uncommitted changes. It verifies a commit: commit or stash them, then run it again.\n');
    return 1;
  }
  for (const dir of ['', 'dashboard', 'website']) {
    if (!existsSync(join(root, dir, 'node_modules'))) {
      process.stderr.write(`preflight — ${dir || 'the root'} has no node_modules: run npm ci${dir ? ` in ${dir}/` : ''} first.\n`);
      return 1;
    }
  }
  const tree = git(['rev-parse', 'HEAD^{tree}']);
  const commit = git(['rev-parse', 'HEAD']);
  const base = baseOf();
  const changed = git(['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean);
  // Root-suite test files only: the dashboard runs its own, and the excluded folders run in their own CI jobs.
  const testFiles = changed.filter((f) => /^tests\/.*\.test\.ts$/.test(f) && !/^tests\/(real-clients|mcpb|stall|upgrade)\//.test(f) && existsSync(join(root, f)));
  const steps = stepsFor(full, changed).filter((s) => !(s.run?.includes(TEST_FILES) && testFiles.length === 0));
  const started = Date.now();
  for (const [i, step] of steps.entries()) {
    const at = Date.now();
    process.stdout.write(`\npreflight ${i + 1}/${steps.length} — ${step.name}\n`);
    let ok;
    let why = '';
    if (step.check) {
      const r = step.check();
      ok = r.ok;
      why = r.why ?? '';
    } else {
      ok = spawnSync(step.run.replaceAll(ROOT_REPORT, rootReport).replaceAll(TEST_FILES, testFiles.join(' ')), { cwd: join(root, step.cwd ?? ''), shell: true, stdio: 'inherit' }).status === 0;
    }
    if (!ok) {
      process.stderr.write(`\npreflight — FAILED at "${step.name}"${why ? `: ${why}` : ''}. CI runs this in ${step.ci.join(', ')}; it would fail there too.\n`);
      return 1;
    }
    process.stdout.write(`preflight ${i + 1}/${steps.length} — ok (${Math.round((Date.now() - at) / 1000)} s)\n`);
  }
  const dirty = git(['status', '--porcelain', '--untracked-files=no']);
  if (dirty) {
    process.stderr.write(`\npreflight — every step passed, but a step changed tracked files, so the commit is not what was verified:\n${dirty}\n`);
    return 1;
  }
  if (git(['rev-parse', 'HEAD']) !== commit) {
    process.stderr.write('\npreflight — HEAD moved while it ran; run it again on the commit you mean to push.\n');
    return 1;
  }
  const stamp = join(resolve(root, git(['rev-parse', '--git-dir'])), 'preflight-ok');
  const mode = full ? 'full' : 'fast';
  writeFileSync(stamp, `${JSON.stringify({ tree, commit, mode, at: new Date().toISOString(), node: process.versions.node, platform: process.platform, steps: steps.length }, null, 2)}\n`);
  const took = Date.now() - started;
  const elapsed = took < 120_000 ? `${Math.round(took / 1000)} s` : `${Math.round(took / 60_000)} min`;
  process.stdout.write(`\npreflight — every ${mode} step passed in ${elapsed}. Verified tree ${tree.slice(0, 12)} (commit ${commit.slice(0, 8)}); recorded in ${stamp}.\n`);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  let code = 1;
  const scratch = mkdtempSync(join(tmpdir(), 'iris-preflight-'));
  try {
    code = main(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  process.exit(code);
}
