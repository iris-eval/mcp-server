/*
 * Suite A — CLI surface.
 *
 * Everything here spawns the real shipped artifact (node dist/index.js)
 * and asserts on exit codes + output. Nothing is imported in-process:
 * the exit-code contract IS the surface a user meets first.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, startServer } from '../lib/proc.mjs';
import { getJson } from '../lib/http.mjs';
import { assert, assertEq } from '../lib/report.mjs';
import { IRIS_ENTRY, WORK_DIR } from '../lib/env.mjs';

/** Flags the README/--help contract promises. Hard-coded on purpose: this list is the acceptance criteria. */
const DOCUMENTED_FLAGS = [
  '--transport',
  '--port',
  '--config',
  '--db-path',
  '--api-key',
  '--dashboard',
  '--dashboard-port',
  '--dashboard-host',
  '--demo',
  '--demo-clear',
  '--self-test',
  '--help',
];

/** Self-test step labels (src/self-test.ts SELF_TEST_STEPS) — every one must show a ✓. */
const SELF_TEST_STEPS = [
  'create isolated temp home',
  'initialize storage',
  'log a trace',
  'eval: PII positive (planted SSN)',
  'eval: injection positive (planted override text)',
  'eval: clean output passes',
  'read back persisted results',
  'start dashboard on ephemeral loopback port',
  'health endpoint answers',
  'stats endpoint answers',
  'rebinding guard rejects hostile Origin',
  'clean up temp home',
];

/** Pull the real parseArgs option names out of the shipped bundle. */
function parseArgsOptionNames() {
  const src = readFileSync(IRIS_ENTRY, 'utf8');
  const start = src.indexOf('parseArgs({');
  assert(start > -1, 'could not locate parseArgs({ in dist/index.js');
  const optStart = src.indexOf('options: {', start);
  const end = src.indexOf('strict: true', optStart);
  assert(optStart > -1 && end > optStart, 'could not locate the parseArgs options block in dist/index.js');
  const block = src.slice(optStart, end);
  const names = [];
  for (const m of block.matchAll(/^\s*'?([a-zA-Z][a-zA-Z0-9-]*)'?:\s*\{\s*type:/gm)) names.push(m[1]);
  return names;
}

export async function runSuiteA(t) {
  t.beginSuite('A', 'CLI surface');

  const homeHelp = join(WORK_DIR, 'a-help');
  const homeSelfTest = join(WORK_DIR, 'a-selftest');
  const homeDemo = join(WORK_DIR, 'a-demo');
  const homeArgs = join(WORK_DIR, 'a-args');
  for (const d of [homeHelp, homeSelfTest, homeDemo, homeArgs]) mkdirSync(d, { recursive: true });

  // ---- A1 --help -------------------------------------------------------
  const help = await runCli(['--help'], { irisHome: homeHelp, timeoutMs: 45_000 });
  const helpText = `${help.stdout}\n${help.stderr}`;

  await t.check('A1', '--help exits 0', () => {
    assertEq(help.code, 0, '--help exit code');
    return 'exit 0';
  });

  await t.check('A2', '--help lists every documented flag', () => {
    const missing = DOCUMENTED_FLAGS.filter((f) => !helpText.includes(f));
    assert(missing.length === 0, `--help omits: ${missing.join(', ')}`);
    return `${DOCUMENTED_FLAGS.length}/${DOCUMENTED_FLAGS.length} flags documented`;
  });

  await t.check('A3', '--help documents every flag the parser actually accepts (drift guard)', () => {
    const parserFlags = parseArgsOptionNames();
    assert(parserFlags.length > 0, 'extracted zero parseArgs options — the drift guard is inert');
    const undocumented = parserFlags.filter((n) => !helpText.includes(`--${n}`));
    assert(undocumented.length === 0, `accepted but undocumented: ${undocumented.map((n) => `--${n}`).join(', ')}`);
    return `${parserFlags.length} parser flags, all documented`;
  });

  // ---- A4 --self-test --------------------------------------------------
  const selfTest = await runCli(['--self-test'], { irisHome: homeSelfTest, timeoutMs: 90_000 });
  const selfText = `${selfTest.stdout}\n${selfTest.stderr}`;

  await t.check('A4', '--self-test exits 0', () => {
    assert(!selfTest.timedOut, '--self-test timed out');
    assertEq(selfTest.code, 0, '--self-test exit code');
    return 'exit 0';
  });

  await t.check('A5', '--self-test reports a ✓ for every documented step and no ✗', () => {
    const missing = SELF_TEST_STEPS.filter((s) => !selfText.includes(`✓ ${s}`));
    assert(missing.length === 0, `steps without a ✓: ${missing.join(' | ')}`);
    assert(!selfText.includes('✗'), `self-test output contains a ✗: ${selfText.split('\n').filter((l) => l.includes('✗')).join(' | ')}`);
    assert(selfText.includes('PASS — this install works'), 'missing the PASS verdict line');
    return `${SELF_TEST_STEPS.length} steps ✓, PASS verdict present`;
  });

  await t.check('A6', '--self-test leaves no scratch home behind', () => {
    const m = selfText.match(/✓ create isolated temp home — (.+)/);
    assert(m, 'self-test did not report its temp home path');
    const tempHome = m[1].trim();
    assert(!existsSync(tempHome), `self-test temp home still exists: ${tempHome}`);
    return 'temp home removed';
  });

  // ---- A7..A10 --demo / --demo-clear ----------------------------------
  const demoFiles = ['demo.db', 'demo-preferences.json', 'demo-custom-rules.json', 'demo-audit.log'];
  let demo;
  try {
    demo = await startServer({
      argsFor: (p) => ['--demo', '--dashboard-port', String(p)],
      irisHome: homeDemo,
      label: '--demo server',
      timeoutMs: 90_000,
    });
  } catch (err) {
    t.fail('A7', '--demo seeds a demo database and serves the dashboard', err.message);
    t.fail('A8', '--demo serves seeded data over the API', 'skipped — --demo never became ready');
  }

  if (demo) {
    await t.check('A7', '--demo seeds a demo database and serves the dashboard', async () => {
      assert(existsSync(join(homeDemo, 'demo.db')), 'demo.db was not created under the scratch IRIS_HOME');
      const health = await getJson(demo.port, '/api/v1/health');
      assertEq(health.status, 'ok', 'demo /health status');
      return `demo.db present, health ok on port ${demo.port}`;
    });

    await t.check('A8', '--demo serves seeded data over the API', async () => {
      const traces = await getJson(demo.port, '/api/v1/traces?limit=5');
      assert(traces.total > 0, `expected seeded traces, got total=${traces.total}`);
      assert(Array.isArray(traces.traces) && traces.traces.length > 0, 'traces array was empty');
      return `${traces.total} seeded traces`;
    });

    await t.check('A9', '--demo writes ONLY demo-scoped files into IRIS_HOME (no real store shape)', () => {
      // iris.db / custom-rules.json / audit.log are the REAL store's file
      // names. Demo mode promises in its banner that it never mixes with
      // them; the scratch home makes that assertable.
      const leaked = ['iris.db', 'custom-rules.json', 'audit.log'].filter((f) => existsSync(join(homeDemo, f)));
      assert(leaked.length === 0, `--demo created real-store files: ${leaked.join(', ')}`);
      return 'no real-store files created';
    });

    await demo.stop();
  }

  await t.check('A10', '--demo-clear exits 0 and removes every demo file', async () => {
    const before = demoFiles.filter((f) => existsSync(join(homeDemo, f)));
    assert(before.length > 0, 'no demo files existed to clear — the check would be vacuous');
    const res = await runCli(['--demo-clear'], { irisHome: homeDemo, timeoutMs: 45_000 });
    assertEq(res.code, 0, '--demo-clear exit code');
    const after = demoFiles.filter((f) => existsSync(join(homeDemo, f)));
    assert(after.length === 0, `--demo-clear left files behind: ${after.join(', ')}`);
    return `cleared ${before.length} file(s): ${before.join(', ')}`;
  });

  // ---- A11..A13 refused flag combinations ------------------------------
  await t.check('A11', '--demo + --demo-clear exits 2', async () => {
    const res = await runCli(['--demo', '--demo-clear'], { irisHome: homeArgs, timeoutMs: 45_000 });
    assertEq(res.code, 2, 'exit code');
    assert(/cannot be combined/i.test(res.stderr), `expected an explanatory stderr message, got: ${res.stderr.slice(0, 200)}`);
    return 'exit 2 with explanation';
  });

  await t.check('A12', '--demo + --db-path exits 2', async () => {
    const res = await runCli(['--demo', '--db-path', join(homeArgs, 'nope.db')], { irisHome: homeArgs, timeoutMs: 45_000 });
    assertEq(res.code, 2, 'exit code');
    assert(!existsSync(join(homeArgs, 'nope.db')), 'a refused combination still created the database file');
    return 'exit 2, no file created';
  });

  await t.check('A13', 'an unknown flag exits 2', async () => {
    const res = await runCli(['--not-a-real-flag'], { irisHome: homeArgs, timeoutMs: 45_000 });
    assertEq(res.code, 2, 'exit code');
    assert(/--help/.test(res.stderr), 'stderr did not point the user at --help');
    return 'exit 2, points at --help';
  });

  await t.check('A14', 'an out-of-range --port exits 2', async () => {
    const res = await runCli(['--port', '99999'], { irisHome: homeArgs, timeoutMs: 45_000 });
    assertEq(res.code, 2, 'exit code');
    return 'exit 2';
  });
}
