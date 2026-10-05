import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * scripts/git-hooks/pre-push, run by git itself on a real push to a bare
 * remote: a branch goes only when `npm run preflight` recorded its tree.
 *
 * A push runs git, the hook's shell and a receiving git: on Windows each
 * process start costs up to about 0.8 s, and the tests below that make three
 * or four pushes took 12 to 14 s there. 60 s is four times that.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const hooks = resolve(__dirname, '..', 'scripts', 'git-hooks');
let dir: string;

const git = (...args: string[]) => spawnSync('git', args, { cwd: join(dir, 'work'), encoding: 'utf-8' });
const push = (...args: string[]) => git('-c', `core.hooksPath=${hooks}`, 'push', 'origin', ...args);
const stamp = (tree: string) => writeFileSync(join(dir, 'work', '.git', 'preflight-ok'), `${JSON.stringify({ tree, commit: 'x' }, null, 2)}\n`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'iris-pre-push-'));
  spawnSync('git', ['init', '-q', '--bare', 'remote.git'], { cwd: dir });
  spawnSync('git', ['init', '-q', '-b', 'main', 'work'], { cwd: dir });
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('remote', 'add', 'origin', join(dir, 'remote.git'));
  writeFileSync(join(dir, 'work', 'a.txt'), 'one\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'one');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('the pre-push hook', () => {
  it('refuses a branch whose tree the preflight has not verified, and says what to run', () => {
    const r = push('main');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/has not passed npm run preflight/);
    expect(spawnSync('git', ['--git-dir', join(dir, 'remote.git'), 'rev-parse', '--verify', '-q', 'refs/heads/main']).status).not.toBe(0);
  });

  it('lets the branch go once the preflight recorded its tree, and not after the tree changes', () => {
    stamp(git('rev-parse', 'HEAD^{tree}').stdout.trim());
    expect(push('main').status).toBe(0);
    writeFileSync(join(dir, 'work', 'a.txt'), 'two\n');
    git('commit', '-q', '-am', 'two');
    expect(push('main').status).not.toBe(0);
  });

  it('does not stand in the way of deleting a branch or pushing a tag', () => {
    stamp(git('rev-parse', 'HEAD^{tree}').stdout.trim());
    expect(push('main:refs/heads/old').status).toBe(0);
    stamp('0000');
    expect(push(':refs/heads/old').status).toBe(0);
    git('tag', 'v1');
    expect(push('v1').status).toBe(0);
  });
});
