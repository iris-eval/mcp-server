/*
 * The unscoped npm name `iris-eval` is held by a frozen placeholder.
 *
 * `npx iris-eval` resolves the unscoped npm name, not the command our package
 * installs, so whoever owns the name decides what a reader who types the
 * command name runs. packages/iris-eval holds it and does one thing: prints,
 * to stderr, the commands that do work, then exits 1. It carries no
 * dependencies and a fixed version, so it never needs a release when the
 * server has one — an earlier version that depended on the server and
 * re-exported it would have needed a publish on every server release, and
 * was never published at all. This suite runs the bin and holds the shape.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMAND } from '../src/identity.js';

const root = resolve(__dirname, '..');
const dir = join(root, 'packages/iris-eval');
const json = (rel: string) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
const server = json('package.json');
const placeholder = json('packages/iris-eval/package.json');

/** The version the placeholder is frozen at; changing it means a new publish, which the placeholder exists to avoid. */
const PLACEHOLDER_VERSION = '1.0.0';

describe('the iris-eval placeholder package', () => {
  it('takes the command name as its npm name, installs that one command, and is frozen at its version', () => {
    expect(placeholder.name).toBe(COMMAND);
    expect(Object.keys(placeholder.bin)).toEqual([COMMAND]);
    expect(placeholder.version).toBe(PLACEHOLDER_VERSION);
    expect(placeholder.private).toBeUndefined();
  });

  it('has no dependencies of any kind and runs no install scripts', () => {
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies']) {
      expect(placeholder[key], key).toBeUndefined();
    }
    expect(placeholder.scripts).toBeUndefined();
  });

  it('prints the server package commands to stderr, nothing to stdout, and exits 1', () => {
    const run = spawnSync(process.execPath, [join(dir, placeholder.bin[COMMAND]), '--anything'], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain(`npx -y ${server.name}\n`);
    expect(run.stderr).toContain(`npx -y ${server.name} install <client>`);
  });

  it('its README names the same commands and says it is a placeholder', () => {
    const readme = readFileSync(join(dir, 'README.md'), 'utf8');
    expect(readme).toMatch(/placeholder/);
    expect(readme).toContain(`npx -y ${server.name} install <client>`);
    expect(readme).not.toMatch(/npx (-y )?iris-eval\b/);
  });
});
