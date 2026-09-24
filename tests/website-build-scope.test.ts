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
  const config = JSON.parse(readFileSync(join(root, 'website', 'vercel.json'), 'utf8')) as { ignoreCommand: string };

  it('skips a deployment only when every changed path is in a folder the site never reads', () => {
    for (const dir of SKIPPED) expect(config.ignoreCommand).toContain(`':(top,exclude)${dir}'`);
    expect(config.ignoreCommand.startsWith('git diff --quiet HEAD^ HEAD --')).toBe(true);
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
