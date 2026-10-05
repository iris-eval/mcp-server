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
 * costs up to about 0.8 s idle, and a push alone took 3.5 to 4 s. Inside
 * the full suite, with every worker starting processes too, a case that ran
 * three hooks and made a commit passed 60 s in two of four runs. So the
 * cases make no commits now (a changed tree is a stamp naming another tree,
 * which the hook reads the same way): the file takes 15.6 s idle, down from
 * 20 s. The limit is website-build-scope.test.ts's, for the same reason:
 * 180 s.
 */
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const hooks = resolve(__dirname, '..', 'scripts', 'git-hooks');
const ZERO = '0'.repeat(40);
let dir: string;
/** The commit the repository holds, and its tree: read once. */
let sha: string;
let tree: string;

const work = (): string => join(dir, 'work');
const git = (...args: string[]) => spawnSync('git', ['-c', `core.hooksPath=${hooks}`, ...args], { cwd: work(), encoding: 'utf-8' });
const stamp = (verified: string): void => writeFileSync(join(work(), '.git', 'preflight-ok'), `${JSON.stringify({ tree: verified, commit: 'x' }, null, 2)}\n`);
/** The hook, run by git as a push would run it, with these lines on stdin. */
function hook(...lines: string[]) {
  const input = join(dir, 'stdin');
  writeFileSync(input, lines.map((l) => `${l}\n`).join(''));
  return git('hook', 'run', `--to-stdin=${input}`, 'pre-push', '--', 'origin', join(dir, 'remote.git'));
}

// One repository for the file, built once rather than once a case.
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
  sha = git('rev-parse', 'HEAD').stdout.trim();
  tree = git('rev-parse', 'HEAD^{tree}').stdout.trim();
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
    const line = `refs/heads/main ${sha} refs/heads/main ${ZERO}`;
    stamp(tree);
    expect(hook(line).status).toBe(0);
    // The preflight verified another tree: the branch's is not the one it passed.
    stamp('f'.repeat(40));
    expect(hook(line).status).not.toBe(0);
  });

  it('does not stand in the way of deleting a branch or pushing a tag', () => {
    expect(hook(`(delete) ${ZERO} refs/heads/old ${sha}`).status).toBe(0);
    expect(hook(`refs/tags/v1 ${sha} refs/tags/v1 ${ZERO}`).status).toBe(0);
  });
});
