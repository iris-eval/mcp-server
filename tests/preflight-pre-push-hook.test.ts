import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/*
 * scripts/git-hooks/pre-push: a branch goes only when `npm run preflight`
 * recorded its tree. One real push shows git runs it on a push; the cases
 * run it through git's own hook runner (`git hook run`), with the lines git
 * would hand it on stdin, which starts far fewer processes than a push.
 *
 * A push or a hook run starts several processes, and on Windows each start
 * costs up to about 0.8 s: there, with the machine idle, the file took 20 s
 * in each of three runs and a push alone 3.5 to 4 s. Under the full suite
 * with other work beside it, a case took over 60 s once a push needed one
 * per case; 60 s a case is now three times the whole file.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const hooks = resolve(__dirname, '..', 'scripts', 'git-hooks');
const ZERO = '0'.repeat(40);
let dir: string;

const work = (): string => join(dir, 'work');
const git = (...args: string[]) => spawnSync('git', ['-c', `core.hooksPath=${hooks}`, ...args], { cwd: work(), encoding: 'utf-8' });
const head = (): { sha: string; tree: string } => ({ sha: git('rev-parse', 'HEAD').stdout.trim(), tree: git('rev-parse', 'HEAD^{tree}').stdout.trim() });
const stamp = (tree: string): void => writeFileSync(join(work(), '.git', 'preflight-ok'), `${JSON.stringify({ tree, commit: 'x' }, null, 2)}\n`);
/** The hook, run by git as a push would run it, with these lines on stdin. */
function hook(...lines: string[]) {
  const input = join(dir, 'stdin');
  writeFileSync(input, lines.map((l) => `${l}\n`).join(''));
  return git('hook', 'run', `--to-stdin=${input}`, 'pre-push', '--', 'origin', join(dir, 'remote.git'));
}

// One repository for the file, built once rather than once a case: seven git processes each time.
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'iris-pre-push-'));
  spawnSync('git', ['init', '-q', '--bare', 'remote.git'], { cwd: dir });
  spawnSync('git', ['init', '-q', '-b', 'main', 'work'], { cwd: dir });
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('remote', 'add', 'origin', join(dir, 'remote.git'));
  writeFileSync(join(work(), 'a.txt'), 'one\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'one');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('the pre-push hook', () => {
  it('git runs it on a push, and it refuses a branch the preflight has not verified, saying what to run', () => {
    const r = git('push', 'origin', 'main');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/has not passed npm run preflight/);
    expect(spawnSync('git', ['--git-dir', join(dir, 'remote.git'), 'rev-parse', '--verify', '-q', 'refs/heads/main']).status).not.toBe(0);
  });

  it('lets a branch go at the tree the preflight recorded, and at no other', () => {
    const { sha, tree } = head();
    const line = `refs/heads/main ${sha} refs/heads/main ${ZERO}`;
    expect(hook(line).status).not.toBe(0);
    stamp(tree);
    expect(hook(line).status).toBe(0);
    writeFileSync(join(work(), 'a.txt'), 'two\n');
    git('commit', '-q', '-am', 'two');
    expect(hook(`refs/heads/main ${head().sha} refs/heads/main ${sha}`).status).not.toBe(0);
  });

  it('does not stand in the way of deleting a branch or pushing a tag', () => {
    const { sha } = head();
    expect(hook(`(delete) ${ZERO} refs/heads/old ${sha}`).status).toBe(0);
    expect(hook(`refs/tags/v1 ${sha} refs/tags/v1 ${ZERO}`).status).toBe(0);
  });
});
