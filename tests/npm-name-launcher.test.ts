/*
 * The unscoped npm name `iris-eval` is a launcher for the server.
 *
 * `npx iris-eval` resolves the unscoped npm name, not the command our package
 * installs, so whoever owns the name decides what a reader who types the
 * command name runs. packages/iris-eval takes it and starts the real server:
 * it depends on @iris-eval/mcp-server alone, at an open-ended range, so a
 * fresh install gets the server's latest release and the launcher itself
 * never needs one. Its version is frozen and it runs no install scripts.
 *
 * This suite holds the manifest and the bin. That the bin starts the server
 * packed from this commit is proved on Linux, macOS and Windows by
 * tests/real-clients/real-clients.test.ts, which runs the bin against the
 * installed tarball.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMAND } from '../src/identity.js';
// @ts-ignore — plain .mjs module
import { LAUNCHER_SERVER_RANGE, LAUNCHER_VERSION } from '../scripts/claims/packages.mjs';

const root = resolve(__dirname, '..');
const dir = join(root, 'packages/iris-eval');
const json = (rel: string) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
const server = json('package.json');
const launcher = json('packages/iris-eval/package.json');

describe('the iris-eval launcher package', () => {
  it('takes the command name as its npm name, installs that one command, and is frozen at its version', () => {
    expect(launcher.name).toBe(COMMAND);
    expect(Object.keys(launcher.bin)).toEqual([COMMAND]);
    expect(launcher.version).toBe(LAUNCHER_VERSION);
    expect(launcher.private).toBeUndefined();
  });

  it('depends on the server package alone, at an open-ended range that starts at the first release with install', () => {
    expect(launcher.dependencies).toEqual({ [server.name]: LAUNCHER_SERVER_RANGE });
    expect(LAUNCHER_SERVER_RANGE).toBe('>=0.19.0');
    for (const key of ['devDependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies']) {
      expect(launcher[key], key).toBeUndefined();
    }
    expect(launcher.scripts).toBeUndefined();
  });

  it('asks for the same Node floor as the server', () => {
    expect(launcher.engines).toEqual(server.engines);
  });

  it('its bin starts the server by importing its entry, which reads the same arguments', () => {
    const bin = readFileSync(join(dir, launcher.bin[COMMAND]), 'utf8');
    expect(bin.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(bin).toContain(`await import('${server.name}')`);
    expect(server.exports['.'].default).toBe(`./${server.bin[COMMAND]}`);
  });

  it('its README says it launches the server and names the server package for client configs', () => {
    const readme = readFileSync(join(dir, 'README.md'), 'utf8');
    expect(readme).toContain('`npx iris-eval` starts');
    expect(readme).toContain(`npx -y ${server.name}@<version>`);
    expect(readme).not.toMatch(/placeholder/i);
  });
});
