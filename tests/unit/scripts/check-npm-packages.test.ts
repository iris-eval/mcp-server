/*
 * scripts/check-npm-packages.mjs — what release.yml's build-packages job
 * checks before it packs the libraries and the launcher. The checked-in
 * manifests pass (tests/package-inventory.test.ts); these cases hold each
 * refusal, so a manifest that could ship without provenance, or a handler
 * whose SDK range excludes the SDK beside it, fails before a release.
 */
import { describe, expect, it } from 'vitest';
// @ts-ignore — plain .mjs module
import { admits, packageProblems, readManifests } from '../../../scripts/check-npm-packages.mjs';

type Manifest = { dir: string; pkg: Record<string, any> };
const clone = (): Manifest[] => JSON.parse(JSON.stringify(readManifests()));
const at = (ms: Manifest[], dir: string): Record<string, any> => ms.find((m) => m.dir === dir)!.pkg;

describe('admits', () => {
  it('reads an exact version, a caret range at each major and >=', () => {
    expect(admits('0.1.0', '0.1.0')).toBe(true);
    expect(admits('0.1.0', '0.1.1')).toBe(false);
    expect(admits('^0.1.0', '0.1.9')).toBe(true);
    expect(admits('^0.1.0', '0.2.0')).toBe(false);
    expect(admits('^0.1.2', '0.1.1')).toBe(false);
    expect(admits('^0.0.3', '0.0.3')).toBe(true);
    expect(admits('^0.0.3', '0.0.4')).toBe(false);
    expect(admits('^1.2.3', '1.9.0')).toBe(true);
    expect(admits('^1.2.3', '2.0.0')).toBe(false);
    expect(admits('>=0.19.0', '0.20.0')).toBe(true);
    expect(admits('>=0.19.0', '0.18.9')).toBe(false);
  });

  it('refuses a range or version it cannot read instead of guessing', () => {
    expect(() => admits('~0.1.0', '0.1.0')).toThrow(/not one this check reads/);
    expect(() => admits('^0.1.0 || ^0.2.0', '0.1.0')).toThrow(/not one this check reads/);
    expect(() => admits('^0.1.0', '0.2.0-rc.1')).toThrow(/not a plain x\.y\.z version/);
  });
});

describe('packageProblems', () => {
  it('the checked-in packages have none', () => {
    expect(packageProblems()).toEqual([]);
  });

  it('a private package, or one whose publishConfig does not require provenance and public access, is refused', () => {
    const ms = clone();
    at(ms, 'packages/sdk').private = true;
    delete at(ms, 'packages/langchain').publishConfig.provenance;
    at(ms, 'packages/iris-eval').publishConfig.access = 'restricted';
    const problems = packageProblems(ms);
    expect(problems).toContain('packages/sdk/package.json is "private": true, so npm refuses to publish it');
    expect(problems).toContain('packages/langchain/package.json publishConfig.provenance is not true, so a publish without provenance would go through');
    expect(problems).toContain('packages/iris-eval/package.json publishConfig.access is not "public"');
  });

  it('a handler whose SDK range excludes the SDK published beside it is refused', () => {
    const ms = clone();
    at(ms, 'packages/sdk').version = '0.2.0';
    expect(packageProblems(ms)).toEqual([
      'packages/langchain/package.json peerDependencies asks for @iris-eval/sdk@^0.1.0, which does not admit the 0.2.0 published beside it',
    ]);
  });

  it('a package published before one it depends on is refused', () => {
    const ms = clone();
    const [sdk, langchain, ...rest] = ms;
    expect(packageProblems([langchain, sdk, ...rest])).toContain(
      'packages/langchain/package.json peerDependencies names @iris-eval/sdk, which is published after it; @iris-eval/sdk must come first in the publish order',
    );
  });

  it('a repository.directory that is not the package\'s directory is refused (npm\'s provenance check compares them)', () => {
    const ms = clone();
    at(ms, 'packages/sdk').repository.directory = 'sdk';
    expect(packageProblems(ms)).toEqual(['packages/sdk/package.json repository.directory is "sdk", not "packages/sdk"']);
  });
});
