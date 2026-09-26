// The build: ESM to dist/esm, CommonJS to dist/cjs (marked as such for Node),
// and, with --tests, the tests and the sources they import to build/, which
// it then runs with node:test (file by file: Node 20's --test takes no globs).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = createRequire(join(root, 'package.json')).resolve('typescript/bin/tsc');
const run = (project) => {
  try {
    execFileSync(process.execPath, [tsc, '-p', join(root, project)], { stdio: 'inherit' });
  } catch {
    process.exit(1); // tsc has printed the errors
  }
};

if (process.argv.includes('--tests')) {
  rmSync(join(root, 'build'), { recursive: true, force: true });
  run('tsconfig.test.json');
  const dir = join(root, 'build', 'test');
  const files = readdirSync(dir).filter((f) => f.endsWith('.test.js')).map((f) => join(dir, f));
  const only = process.argv.slice(process.argv.indexOf('--tests') + 1).filter((a) => !a.startsWith('--'));
  const chosen = only.length > 0 ? files.filter((f) => only.some((o) => f.includes(o))) : files;
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...chosen], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
} else {
  rmSync(join(root, 'dist'), { recursive: true, force: true });
  run('tsconfig.json');
  run('tsconfig.cjs.json');
  mkdirSync(join(root, 'dist', 'cjs'), { recursive: true });
  writeFileSync(join(root, 'dist', 'cjs', 'package.json'), '{ "type": "commonjs" }\n');
}
