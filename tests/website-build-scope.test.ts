/*
 * The site builds only when something its build reads has changed
 * (website/vercel.json `ignoreCommand` → website/scripts/ignore-build.sh).
 * Every pull request used to spend a preview deployment, and on one day of
 * merges they used up the host's daily build allowance, which production
 * deployments of the live site share. The script now builds a preview only
 * for a change to website/ or docs/blog/, and production also for a
 * .claims.json change beyond its stamp.
 *
 * Two things are held here: the premise (no website source reads anything in
 * the repository outside those three paths), and the behaviour (the real
 * script, run in a scratch git repository, skips and builds as it says).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const website = join(root, 'website');
const script = readFileSync(join(website, 'scripts', 'ignore-build.sh'), 'utf8');

/** The repository paths outside website/ that the site's build reads: the script's list, and nothing else. */
const OUTSIDE_READS = ['docs/blog', '.claims.json'];

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === '.next') return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

describe('the website build scope', () => {
  const config = JSON.parse(readFileSync(join(website, 'vercel.json'), 'utf8')) as { ignoreCommand: string; git?: { deploymentEnabled?: Record<string, boolean> } };

  it('runs the ignore script, which names exactly the paths the build reads and builds on any error', () => {
    // The host caps ignoreCommand at 256 characters (its published schema), so the logic lives in a script.
    expect(config.ignoreCommand.length).toBeLessThanOrEqual(256);
    expect(config.ignoreCommand).toBe('sh scripts/ignore-build.sh');
    expect(script).toContain("git diff --quiet \"$base\" HEAD -- ':(top)website' ':(top)docs/blog' || exit 1");
    expect(script).toContain("':(top).claims.json'");
    // Against the last successful deployment; a commit that no longer exists (a force-pushed
    // branch) falls back to the parent, and any git error builds, because the host fails the
    // deployment on an exit code above 1 instead of building (seen 2026-09-25).
    expect(script).toContain('base="${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}"');
    expect(script).toContain('git cat-file -e "${base}^{commit}" 2>/dev/null || base="HEAD^"');
    expect(script.trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('never creates a deployment for a dependency-bot branch', () => {
    // A skipped build still counts toward the host's daily deployment limit, so bursts of
    // bot branches are kept from creating deployments at all. CI still builds and checks
    // the website on those pull requests; the live site deploys on merge.
    expect(config.git?.deploymentEnabled?.['dependabot/**']).toBe(false);
  });

  it('no website build source reads anything outside website/ but docs/blog and .claims.json', () => {
    // What `next build` compiles: src/ and the config files at the site's root. website/scripts/
    // holds maintenance scripts run by hand or by CI, not by the build.
    const files = walk(website).filter(
      (f) => /\.(ts|tsx|mts|mjs|js|json)$/.test(f) && !f.includes(`${sep}scripts${sep}`) && !f.endsWith('vercel.json') && !f.includes(`${sep}public${sep}`),
    );
    expect(files.length).toBeGreaterThan(50);
    const escapes: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      // Relative module specifiers: import … from '…', import('…'), require('…'), export … from '…'.
      for (const m of text.matchAll(/(?:from|import|require)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const target = resolve(dirname(file), m[1]);
        if (!target.startsWith(website + sep)) escapes.push(relative(root, target).split(sep).join('/'));
      }
      // Filesystem paths built from the site's directory: join(process.cwd(), '..', 'a', 'b').
      for (const m of text.matchAll(/process\.cwd\(\)\s*,\s*((?:['"][^'"]+['"]\s*,?\s*)+)\)/g)) {
        const parts = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((p) => p[1]);
        const target = resolve(website, ...parts);
        if (!target.startsWith(website + sep)) escapes.push(relative(root, target).split(sep).join('/'));
      }
    }
    // The walk found the reads it should: the truthbase and the blog.
    expect(escapes).toContain('.claims.json');
    expect(escapes).toContain('docs/blog');
    const unlisted = escapes.filter((p) => !OUTSIDE_READS.some((listed) => p === listed || p.startsWith(`${listed}/`)));
    expect(unlisted, 'a website source reads a path the ignore script does not watch').toEqual([]);
  });
});

/*
 * The script itself, in a scratch repository shaped like this one: its exit
 * code is what Vercel reads (0 skips, 1 builds). Needs `git`, `sh` and `node`
 * on PATH, which every CI runner and a Windows checkout with Git have.
 */
// Each case spawns git, sh and node a dozen times; on a loaded Windows runner that takes seconds.
describe('website/scripts/ignore-build.sh', { timeout: 60_000 }, () => {
  const repo = mkdtempSync(join(tmpdir(), 'iris-ignore-build-'));
  afterAll(() => rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), text);
  };
  const commit = (message: string) => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const claims = (fields: Record<string, unknown>) => JSON.stringify({ generatedAt: '2026-09-28T00:00:00Z', generatedFromCommit: 'abc1234', ...fields }, null, 2);
  /** Runs the script from website/, as the host does, and returns its exit code. */
  const run = (env: Record<string, string>) =>
    spawnSync('sh', [join(repo, 'website', 'scripts', 'ignore-build.sh')], { cwd: join(repo, 'website'), env: { ...process.env, ...env }, encoding: 'utf8' }).status;

  git('init', '-q');
  git('config', 'user.email', 'ci@example.com');
  git('config', 'user.name', 'ci');
  git('config', 'core.autocrlf', 'false');
  write('website/scripts/ignore-build.sh', script);
  write('website/src/page.tsx', 'export default 1;\n');
  write('docs/blog/post.md', '# post\n');
  write('.claims.json', claims({ tests: { total: 10 } }));
  write('src/server.ts', 'export {};\n');
  write('tests/a.test.ts', '\n');
  const start = commit('start');

  const cases: Array<{ what: string; change: () => void; preview: 0 | 1; production: 0 | 1 }> = [
    { what: 'a server-only change', change: () => write('src/server.ts', 'export const x = 1;\n'), preview: 0, production: 0 },
    { what: 'a test-only change', change: () => write('tests/a.test.ts', '// x\n'), preview: 0, production: 0 },
    { what: 'only the .claims.json stamp', change: () => write('.claims.json', claims({ tests: { total: 10 } }).replace('abc1234', 'def5678')), preview: 0, production: 0 },
    { what: 'a .claims.json value', change: () => write('.claims.json', claims({ tests: { total: 11 } })), preview: 0, production: 1 },
    { what: 'a website change', change: () => write('website/src/page.tsx', 'export default 2;\n'), preview: 1, production: 1 },
    { what: 'a blog post', change: () => write('docs/blog/post.md', '# post, edited\n'), preview: 1, production: 1 },
  ];

  it.each(cases)('$what: preview $preview, production $production (0 skips, 1 builds)', ({ change, preview, production }) => {
    git('checkout', '-q', '--detach', start);
    change();
    commit('change');
    expect(run({ VERCEL_ENV: 'preview', VERCEL_GIT_PREVIOUS_SHA: start })).toBe(preview);
    expect(run({ VERCEL_ENV: 'production', VERCEL_GIT_PREVIOUS_SHA: start })).toBe(production);
    // With no previous deployment recorded, the parent commit is the base: the same answer.
    expect(run({ VERCEL_ENV: 'preview', VERCEL_GIT_PREVIOUS_SHA: '' })).toBe(preview);
  });

  it('a previous deployment that no longer exists (a force-pushed branch) compares with the parent', () => {
    git('checkout', '-q', '--detach', start);
    write('tests/a.test.ts', '// y\n');
    commit('test only');
    expect(run({ VERCEL_ENV: 'preview', VERCEL_GIT_PREVIOUS_SHA: '0123456789abcdef0123456789abcdef01234567' })).toBe(0);
  });
});
