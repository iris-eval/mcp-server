import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { irisHome } from '../../../src/utils/iris-home.js';

const ORIGINAL = process.env.IRIS_HOME;

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.IRIS_HOME;
  } else {
    process.env.IRIS_HOME = ORIGINAL;
  }
});

describe('irisHome', () => {
  it('defaults to ~/.iris', () => {
    delete process.env.IRIS_HOME;
    expect(irisHome()).toBe(join(homedir(), '.iris'));
  });

  it('honours IRIS_HOME', () => {
    process.env.IRIS_HOME = join('C:', 'scratch', 'iris-test-home');
    expect(irisHome()).toBe(join('C:', 'scratch', 'iris-test-home'));
  });

  it('reads the env at call time, not module load', () => {
    // The E2E/stdio harnesses set IRIS_HOME on a CHILD process before
    // spawn, but in-process callers (and future tests) may flip it
    // between calls — a module-load snapshot would silently ignore that.
    delete process.env.IRIS_HOME;
    const before = irisHome();
    process.env.IRIS_HOME = join('C:', 'scratch', 'flipped');
    const after = irisHome();
    expect(before).toBe(join(homedir(), '.iris'));
    expect(after).toBe(join('C:', 'scratch', 'flipped'));
  });
});
