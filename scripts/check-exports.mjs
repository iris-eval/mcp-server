#!/usr/bin/env node
/*
 * check-exports — the packed tarball resolves the subpaths it promises.
 *
 * `package.json` promises `.`, `./engine`, `./client` and a `./dist/*`
 * passthrough. An exports map is checked by nobody until a consumer
 * installs the tarball, so this script does what a consumer does: packs
 * the tree, installs the tarball into a never-used directory, and imports
 * each subpath from there — then evaluates one stub output through the
 * engine and checks the client's shape. Run by the CI `build` job after
 * `npm run build`; runnable locally the same way.
 *
 *   node scripts/check-exports.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'iris-exports-'));

// No shell anywhere: through one, a node path with a space in it splits at
// the space, and Node (DEP0190) warns that shell arguments are concatenated,
// not escaped. npm is itself a node script — run it with the node that runs
// us when its cli sits beside the binary (the stock layout on every
// platform); otherwise fall back to the `npm` on PATH.
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npm = existsSync(npmCli) ? [process.execPath, npmCli] : [process.platform === 'win32' ? 'npm.cmd' : 'npm'];
const run = (argv, cwd) => {
  const [cmd, ...args] = argv;
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, npm_config_update_notifier: 'false' } });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error(`${argv.join(' ')} exited ${r.status}`);
  }
  return r.stdout;
};

try {
  const packDir = join(scratch, 'pack');
  const consumer = join(scratch, 'consumer');
  for (const d of [packDir, consumer]) mkdirSync(d, { recursive: true });
  run([...npm, 'pack', '--pack-destination', packDir, '--silent'], root);
  const tarball = readdirSync(packDir).find((f) => f.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack produced no tarball');
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  run([...npm, 'install', '--no-audit', '--no-fund', '--omit=dev', '--silent', join(packDir, tarball)], consumer);
  writeFileSync(
    join(consumer, 'probe.mjs'),
    [
      "import { createRequire } from 'node:module';",
      "import { EvalEngine, defaultConfig, builtInRules, compose, verdictPath, DEFAULT_COMPOSE, PKG_VERSION } from '@iris-eval/mcp-server/engine';",
      "import { createClient, IrisClientError } from '@iris-eval/mcp-server/client';",
      'const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);',
      "const result = await engine.evaluateAll({ output: 'TODO: write the summary.' });",
      "if (result.verdict?.state !== 'fail') throw new Error('engine: a stub output should fail, got ' + result.verdict?.state);",
      "if (!result.rule_results.some((r) => r.ruleName === 'no_stub_output' && r.passed === false)) throw new Error('engine: no_stub_output did not fire');",
      "if (builtInRules().length < 20) throw new Error('engine: the roster is short: ' + builtInRules().length);",
      "if (typeof compose !== 'function') throw new Error('engine: compose is not exported');",
      "// VerdictNode is a type, so the runtime proof of it is the function that returns one.",
      "const path = verdictPath(result, DEFAULT_COMPOSE);",
      "const decided = path.filter((n) => n.decided);",
      "if (decided.length !== 1) throw new Error('engine: a failed verdict should have exactly one deciding node, got ' + decided.length);",
      "if (decided[0].node !== 'gate' && decided[0].node !== 'veto' && decided[0].node !== 'risk') throw new Error('engine: unexpected deciding node ' + decided[0].node);",
      "if (JSON.stringify(decided[0].by) !== JSON.stringify(result.verdict.by)) throw new Error('engine: the path and the verdict disagree on what decided');",
      "const client = createClient({ baseUrl: 'http://127.0.0.1:1/' });",
      "if (typeof client.logTrace !== 'function' || typeof client.health !== 'function') throw new Error('client: shape');",
      "if (typeof IrisClientError !== 'function') throw new Error('client: IrisClientError');",
      'const require = createRequire(import.meta.url);',
      "const deep = require.resolve('@iris-eval/mcp-server/dist/index.js');",
      "if (!deep.endsWith('index.js')) throw new Error('the ./dist/* passthrough did not resolve');",
      "console.log('exports ok: engine ' + PKG_VERSION + ', ' + builtInRules().length + ' rules, verdict ' + result.verdict.state + ' by ' + decided[0].node + ', client shape, dist passthrough');",
    ].join('\n'),
  );
  const out = run([process.execPath, join(consumer, 'probe.mjs')], consumer);
  process.stdout.write(out);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
