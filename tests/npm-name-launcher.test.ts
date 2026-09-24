/*
 * `npx iris-eval` resolves the unscoped npm name, not the command our package
 * installs. packages/iris-eval claims that name and starts the real server,
 * so a reader who types the command name never runs someone else's package.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMAND } from '../src/identity.js';

const root = resolve(__dirname, '..');
const json = (rel: string) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
const server = json('package.json');
const launcher = json('packages/iris-eval/package.json');

describe('the iris-eval launcher package', () => {
  it('takes the command name as its npm name and installs that one command', () => {
    expect(launcher.name).toBe(COMMAND);
    expect(Object.keys(launcher.bin)).toEqual([COMMAND]);
  });

  it('depends on the server package only, and starts it', () => {
    expect(Object.keys(launcher.dependencies)).toEqual([server.name]);
    const bin = readFileSync(join(root, 'packages/iris-eval', launcher.bin[COMMAND]), 'utf8');
    expect(bin.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(bin).toContain(`await import('${server.name}')`);
  });

  it('asks for the same Node floor as the server', () => {
    expect(launcher.engines).toEqual(server.engines);
  });
});
