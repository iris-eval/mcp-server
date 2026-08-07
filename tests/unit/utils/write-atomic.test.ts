import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAtomic } from '../../../src/utils/write-atomic.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'iris-atomic-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeAtomic', () => {
  it('writes the file', () => {
    const target = join(dir, 'a.json');
    writeAtomic(target, '{"x":1}');
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ x: 1 });
  });

  it('overwrites an existing file', () => {
    const target = join(dir, 'b.json');
    writeAtomic(target, 'first');
    writeAtomic(target, 'second');
    expect(readFileSync(target, 'utf-8')).toBe('second');
  });

  /*
   * The regression this file exists for.
   *
   * The temp path used to be `${targetPath}.tmp.${process.pid}` — keyed on
   * the PROCESS, not the call. Two writes to the same target inside one
   * process therefore shared a single temp path, and on Windows one call
   * would rename it away while the other still held it:
   *
   *   EPERM: operation not permitted, rename '...preferences.json.tmp.38468'
   *
   * That surfaced twice in one session as an unrelated-looking test failure
   * (custom-rule-store, then preferences). Interleaving writes to one target
   * reproduces the shape of it; each call must use its own temp file.
   */
  it('survives many writes to the same target without temp-path collisions', () => {
    const target = join(dir, 'contended.json');
    for (let i = 0; i < 50; i++) {
      writeAtomic(target, JSON.stringify({ i }));
    }
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ i: 49 });
  });

  it('leaves no temp files behind', () => {
    const target = join(dir, 'clean.json');
    writeAtomic(target, 'one');
    writeAtomic(target, 'two');
    const strays = readdirSync(dir).filter((f) => f.includes('.tmp.'));
    expect(strays).toEqual([]);
  });

  it('creates missing parent directories', () => {
    const target = join(dir, 'nested', 'deep', 'c.json');
    writeAtomic(target, 'ok');
    expect(existsSync(target)).toBe(true);
  });

  // Retries cover transient Windows sharing violations only. A real failure
  // (bad path, unwritable location) must still throw promptly rather than
  // being retried into a slow, confusing timeout.
  it('throws immediately on a non-transient error', () => {
    // A directory cannot be overwritten by a file rename.
    const target = join(dir, 'blocking-dir');
    rmSync(target, { recursive: true, force: true });
    writeAtomic(join(dir, 'seed.json'), 'x');
    expect(() => writeAtomic(join('\0invalid', 'nope.json'), 'x')).toThrow();
  });
});
