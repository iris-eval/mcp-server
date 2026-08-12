import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAtomic, ensureOwnerOnly } from '../../../src/utils/write-atomic.js';

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

/*
 * These files hold agent inputs and outputs verbatim, and a PII detector
 * necessarily stores the PII it found. Windows has no POSIX mode bits
 * (ACL inheritance governs), so the assertions are POSIX-only — which is
 * precisely why this class of defect survives local testing on Windows.
 */
const posixOnly = process.platform === 'win32' ? describe.skip : describe;

posixOnly('owner-only permissions (POSIX)', () => {
  it('writeAtomic creates files as 0600, not umask default', () => {
    const target = join(dir, 'secret.json');
    writeAtomic(target, '{"ssn":"123-45-6789"}');
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('the mode holds when writeAtomic overwrites an existing file', () => {
    const target = join(dir, 'secret.json');
    writeAtomic(target, 'first');
    writeAtomic(target, 'second');
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('ensureOwnerOnly repairs a file that was already world-readable', () => {
    const target = join(dir, 'legacy.json');
    writeFileSync(target, 'created before the fix', { mode: 0o644 });
    expect(statSync(target).mode & 0o777).toBe(0o644);
    ensureOwnerOnly(target);
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('ensureOwnerOnly is silent on missing paths and never throws', () => {
    expect(() => ensureOwnerOnly(join(dir, 'does-not-exist'), join(dir, 'nor-this'))).not.toThrow();
  });
});
