/*
 * The site skips a deployment when a commit only touches folders it never
 * reads (website/vercel.json `ignoreCommand`). Dependency bumps for the
 * dashboard, the init package and CI used to spend a deployment each, and a
 * burst of them exhausted the host's daily deployment limit. This holds the
 * premise: nothing the site builds from reads those folders.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const SKIPPED = ['dashboard', 'tests', 'packages', '.github'];

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === '.next') return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

describe('the website build scope', () => {
  const config = JSON.parse(readFileSync(join(root, 'website', 'vercel.json'), 'utf8')) as { ignoreCommand: string; git?: { deploymentEnabled?: Record<string, boolean> } };

  it('skips a build only when every path changed since the last successful deployment is in a folder the site never reads', () => {
    for (const dir of SKIPPED) expect(config.ignoreCommand).toContain(`':(top,exclude)${dir}'`);
    // Against the last successful deployment, not the parent commit: a refused or failed
    // site deployment must not be followed by a skipped one. With no previous deployment
    // it falls back to the parent; a commit outside the shallow clone makes git exit 128,
    // which builds.
    expect(config.ignoreCommand).toContain('git diff --quiet "$base" HEAD --');
    // A commit that no longer exists (a force-pushed branch) falls back to the parent,
    // and any git error becomes "build": the host fails the deployment on an exit
    // code above 1 instead of building (seen 2026-09-25).
    expect(config.ignoreCommand).toContain('git cat-file -e "$base^{commit}" 2>/dev/null || base="HEAD^"');
    expect(config.ignoreCommand.trimEnd().endsWith('&& exit 0 || exit 1')).toBe(true);
  });

  it('never creates a deployment for a dependency-bot branch', () => {
    // A skipped build still counts toward the host's daily deployment limit, so bursts of
    // bot branches are kept from creating deployments at all. CI still builds and checks
    // the website on those pull requests; the live site deploys on merge.
    expect(config.git?.deploymentEnabled?.['dependabot/**']).toBe(false);
  });

  it('no website source reaches into a skipped folder', () => {
    const files = walk(join(root, 'website')).filter((f) => /\.(ts|tsx|mjs|js|json)$/.test(f) && !f.endsWith('vercel.json'));
    expect(files.length).toBeGreaterThan(50);
    const names = SKIPPED.map((d) => d.replace('.', String.raw`\.`)).join('|');
    // A read is a relative path into the folder, or a path join through '..' into it.
    const reach = new RegExp(String.raw`(\.\./)+(${names})/|["']\.\.["']\s*,\s*["'](${names})["']`);
    const offenders = files.filter((f) => reach.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length + 1));
    expect(offenders).toEqual([]);
  });
});
